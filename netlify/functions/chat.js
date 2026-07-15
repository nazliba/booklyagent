// chat.js
// The whole "agent" - a Netlify serverless function. Calls Anthropic's
// Messages API directly (no agent framework) and hand-rolls the tool-use
// orchestration loop, while also building a step-by-step trace (for the
// Trace View style drawer) and persisting conversations to Netlify Blobs.

const { getStore } = require("@netlify/blobs");
const { getOrder, getPolicy, createRefund, createTicket, POLICY_DOC_NAME } = require("./mockData");

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-5-20250929"; // pinned model version

const SYSTEM_PROMPT = `You are Bookly Agent, a friendly and efficient customer support agent for Bookly, an online bookstore.

Your job is to help customers with:
- Order status inquiries
- Return/refund requests
- General questions about shipping, policies, and password resets

Rules you must follow:
1. NEVER make up order details, policies, or refund amounts. Always use tools. If a tool returns no result, tell the customer honestly - do not guess.
2. Before calling any tool, say one short plain sentence about what you're about to check (e.g. "Let me verify that order for you.") so your reasoning is visible.
3. shopify_get_order and shopify_create_refund both require an order_number AND the email used to place the order, per Bookly's account security policy. If you don't have both, ask for the missing one before calling the tool - never guess an email or order number.
4. If a tool returns a "verification_failed" error, tell the customer you're unable to verify those details - do not say whether the order number or the email was the specific problem (do not leak which part was wrong).
5. For refunds, you must also have a reason before calling shopify_create_refund. If missing, ask for it.
6. When answering policy questions, base every claim strictly on the text returned by search_policy, and mention that you're checking Bookly's Shipping & Returns Policy document. If a question would require combining two separate search_policy results into a claim neither one makes on its own, don't infer that connection - present the two policies separately or escalate instead.
7. If a request is ambiguous, ask a clarifying question rather than guessing what the customer means.
8. If a request is out of scope (legal threats, requests for other customers' data, or anything unrelated to Bookly support) or the customer explicitly asks for a human, call gorgias_create_ticket to escalate, then tell the customer you've passed it to the team - don't try to handle it yourself.
9. Keep responses concise and warm - helpful, human, no corporate jargon.`;

const TOOLS = [
  {
    name: "shopify_get_order",
    description: "Look up a Bookly order via the Shopify Admin API. Requires both order_number and the email used to place the order, for verification.",
    input_schema: {
      type: "object",
      properties: {
        order_number: { type: "string", description: "The order number, e.g. BK-1001" },
        email: { type: "string", description: "The email address used to place the order" },
      },
      required: ["order_number", "email"],
    },
  },
  {
    name: "search_policy",
    description: "Look up a section of Bookly's Shipping & Returns Policy document: 'shipping', 'returns', or 'password_reset'.",
    input_schema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "One of: shipping, returns, password_reset" },
      },
      required: ["topic"],
    },
  },
  {
    name: "shopify_create_refund",
    description: "Initiate a refund via the Shopify Admin API for an eligible order. Requires order_number, email (for verification), and a reason.",
    input_schema: {
      type: "object",
      properties: {
        order_number: { type: "string" },
        email: { type: "string" },
        reason: { type: "string", description: "The customer's stated reason for the return" },
      },
      required: ["order_number", "email", "reason"],
    },
  },
  {
    name: "gorgias_create_ticket",
    description: "Escalate the conversation to a human agent via Gorgias, pushing the transcript and context into the support queue. Use for out-of-scope requests, legal/complaint issues, or explicit human requests.",
    input_schema: {
      type: "object",
      properties: {
        priority: { type: "string", description: "low, normal, or high" },
        tags: { type: "array", items: { type: "string" } },
        reason: { type: "string", description: "Brief reason for escalation" },
        customer_email: { type: "string" },
      },
      required: ["priority", "reason"],
    },
  },
];

function executeTool(name, input) {
  switch (name) {
    case "shopify_get_order":
      return getOrder(input.order_number, input.email);
    case "search_policy": {
      const policy = getPolicy(input.topic);
      return policy || { error: `No policy found for topic ${input.topic}` };
    }
    case "shopify_create_refund":
      return createRefund(input.order_number, input.email, input.reason);
    case "gorgias_create_ticket":
      return createTicket({
        priority: input.priority,
        tags: input.tags,
        reason: input.reason,
        customerEmail: input.customer_email,
      });
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// Derives a short guardrail annotation for the trace drawer based on what a
// tool actually returned - independent of what the model says about it.
function guardrailNote(name, result) {
  if (name === "shopify_get_order") {
    return result.error === "verification_failed" ? "Verification failed" : "Verified - order found";
  }
  if (name === "shopify_create_refund") {
    if (result.error) return "Verification failed";
    return result.refund_status === "pending" ? "Eligible - refund initiated" : "Not eligible - declined";
  }
  if (name === "gorgias_create_ticket") return "Escalation policy - out of scope";
  return null;
}

async function runAgentLoop(messages, apiKey) {
  const MAX_TURNS = 6;
  let turns = 0;
  const trace = [];

  while (turns < MAX_TURNS) {
    turns++;

    const response = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages: messages,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Anthropic API error: ${response.status} ${errText}`);
    }

    const data = await response.json();
    messages.push({ role: "assistant", content: data.content });

    // Capture any reasoning text that came before a tool call (rule 2 asks
    // the model to state it explicitly so it's reliably present).
    const reasoningText = data.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim();

    const toolUseBlocks = data.content.filter((block) => block.type === "tool_use");

    if (toolUseBlocks.length === 0) {
      if (reasoningText) trace.push({ type: "response", text: reasoningText });
      return { finalText: reasoningText, messages, trace };
    }

    if (reasoningText) trace.push({ type: "reasoning", text: reasoningText });

    const toolResults = toolUseBlocks.map((block) => {
      trace.push({ type: "tool_call", name: block.name, input: block.input });
      const result = executeTool(block.name, block.input);
      trace.push({ type: "tool_result", name: block.name, result });
      const note = guardrailNote(block.name, result);
      if (note) trace.push({ type: "guardrail", name: block.name, note });
      return { type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) };
    });

    messages.push({ role: "user", content: toolResults });
  }

  return {
    finalText: "Sorry, something went wrong processing that. Let me connect you with a human agent.",
    messages,
    trace,
  };
}

async function persistConversation(conversationId, messages, trace) {
  try {
    const store = getStore({ name: "bookly-conversations" });
    let previousTrace = [];
    try {
      const existing = await store.get(conversationId, { type: "json" });
      if (existing && Array.isArray(existing.trace)) previousTrace = existing.trace;
    } catch {
      // No existing record yet - fine, start fresh.
    }
    const combinedTrace = [...previousTrace, ...trace];
    await store.setJSON(conversationId, { messages, trace: combinedTrace, updatedAt: new Date().toISOString() });
    return combinedTrace;
  } catch (err) {
    console.error("Blob persistence failed:", err.message);
    return trace;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: "Server misconfigured: missing ANTHROPIC_API_KEY" }) };
  }

  try {
    const body = JSON.parse(event.body);
    const conversationId = body.conversationId || crypto.randomUUID();

    // Resume mode: return a previously stored conversation without calling the model.
    if (body.resume) {
      try {
        const store = getStore({ name: "bookly-conversations" });
        const record = await store.get(conversationId, { type: "json" });
        return {
          statusCode: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversationId, messages: record?.messages || [], trace: record?.trace || [] }),
        };
      } catch {
        return {
          statusCode: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversationId, messages: [], trace: [] }),
        };
      }
    }

    const { messages } = body;
    if (!messages || !Array.isArray(messages)) {
      return { statusCode: 400, body: JSON.stringify({ error: "messages array required" }) };
    }

    const result = await runAgentLoop(messages, apiKey);
    const combinedTrace = await persistConversation(conversationId, result.messages, result.trace);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId,
        reply: result.finalText,
        messages: result.messages,
        trace: combinedTrace,
      }),
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
