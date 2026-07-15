# Bookly Agent

A customer support AI agent for Bookly (fictional online bookstore), built for the Decagon
Solutions Engineering take-home.

## Architecture

- **Frontend**: static storefront (`public/index.html`) with an in-page chat + trace drawer
  modal - no separate page navigation. Vanilla HTML/CSS/JS.
- **Backend**: a single Netlify serverless function (`netlify/functions/chat.js`) that calls the
  Anthropic Messages API **directly** - no agent framework. Hand-rolls the tool-use orchestration
  loop: send message -> check for tool calls -> execute -> send result back -> repeat, while
  building a step-by-step trace for the transparency drawer.
- **Tools** (mocked in `netlify/functions/mockData.js`, shaped like real downstream systems):
  - `shopify_get_order` - Shopify Admin API style order lookup, requires order number **and**
    email for verification
  - `search_policy` - looks up Bookly's Shipping & Returns Policy document
  - `shopify_create_refund` - Shopify Admin API style refund, returns `"pending"` (not an
    instant confirmation, mirroring real async settlement)
  - `gorgias_create_ticket` - Gorgias style human escalation, pushes transcript/context into a
    mock support queue
- **Persistence**: Netlify Blobs (`@netlify/blobs`) stores each conversation's full message
  history and trace server-side, keyed by a `conversationId` kept in the browser's
  `localStorage`. Refreshing the page resumes the same conversation instead of losing it.
- **Transparency**: every turn's reasoning, tool calls, tool results, and guardrail checks are
  captured into a `trace` array and rendered in a right-side drawer alongside the chat -
  modeled on Decagon's own Trace View.

## Why this architecture

The Anthropic API key never touches the browser - the static site calls a serverless function
which holds the key server-side. Tool names and response shapes mirror real systems (Shopify,
Gorgias) rather than generic function names, so the mock layer is a believable stand-in for a
production integration.

## Run locally

1. Install the [Netlify CLI](https://docs.netlify.com/cli/get-started/): `npm install -g netlify-cli`
2. Install dependencies: `npm install`
3. Set your API key: `export ANTHROPIC_API_KEY=sk-ant-...`
4. From the project root: `netlify dev`
5. Open the local URL it prints (usually `http://localhost:8888`)

## Deploy to Netlify

1. `cd` into this folder in a terminal
2. `netlify login`
3. `netlify deploy --prod` - answer the prompts (create new project, publish directory `public`
   is auto-detected from `netlify.toml`)
4. `netlify env:set ANTHROPIC_API_KEY sk-ant-your-key-here`
5. `netlify deploy --prod` again so the key takes effect

## Test scenarios (for the demo recording)

- **Verification requirement**: "Where's my order BK-1001?" -> agent asks for the email too
  before calling `shopify_get_order`
- **Multi-turn / info collection**: "I want a refund" -> agent asks for order number, email,
  and reason before calling `shopify_create_refund`
- **Clarifying question**: "I have a problem with my order" -> agent asks what kind of problem
- **Policy lookup, named source**: "What's your return policy?" -> agent calls `search_policy`
  and references the Shipping & Returns Policy document by name
- **Escalation**: "This is a legal issue, I need a person" -> agent calls `gorgias_create_ticket`
  rather than trying to handle it
- **Persistence**: send a few messages, refresh the page, chat resumes with full history and trace

## Mock order data (for testing)

| Order | Email | Item | Status | Return eligible |
|---|---|---|---|---|
| BK-1001 | j.smith@email.com | Don Quixote | Fulfilled | Yes |
| BK-1002 | a.chen@email.com | Frankenstein | Unfulfilled | No |
| BK-1003 | j.smith@email.com | Pride and Prejudice | Fulfilled (old) | No - past window |

## What I'd change for production

Real Shopify/Gorgias integrations instead of mocks, a proper database instead of Blobs if
transcripts need to be queried/searched, and an eval set to catch regressions before they ship.
See the pitch deck for the fuller discussion of trade-offs.
