// mockData.js
// Stands in for real downstream systems: Shopify Admin API (orders + refunds)
// and Gorgias (human escalation / ticketing). Shapes mirror those platforms'
// actual API fields so the agent's tool layer looks like a real integration.

const POLICY_DOC_NAME = "Bookly Shipping & Returns Policy";

const ORDERS = {
  "BK-1001": {
    order_number: "BK-1001",
    email: "j.smith@email.com",
    fulfillment_status: "fulfilled",
    financial_status: "paid",
    line_items: [{ title: "Don Quixote", price: "12.99" }],
    delivered_date: "2026-07-02",
    return_eligible: true,
  },
  "BK-1002": {
    order_number: "BK-1002",
    email: "a.chen@email.com",
    fulfillment_status: "unfulfilled",
    financial_status: "paid",
    line_items: [{ title: "Frankenstein", price: "9.99" }],
    delivered_date: null,
    return_eligible: false,
  },
  "BK-1003": {
    order_number: "BK-1003",
    email: "j.smith@email.com",
    fulfillment_status: "fulfilled",
    financial_status: "paid",
    line_items: [{ title: "Pride and Prejudice", price: "10.99" }],
    delivered_date: "2026-05-05",
    return_eligible: false,
  },
  "12345": {
    order_number: "12345",
    email: "nazli.basoglu@gmail.com",
    fulfillment_status: "shipped",
    financial_status: "paid",
    line_items: [{ title: "Frankenstein", price: "9.99" }],
    shipped_date: "2026-07-14",
    delivered_date: null,
    shipping_update:
      "Your order has shipped and is currently in transit. Based on current carrier tracking, you can expect delivery within the next 2-3 business days.",
    return_eligible: false,
  },
  "12340": {
    order_number: "12340",
    email: "nazli.basoglu@gmail.com",
    fulfillment_status: "fulfilled",
    financial_status: "paid",
    line_items: [{ title: "The Divine Comedy", price: "13.99" }],
    delivered_date: "2026-05-01",
    return_eligible: false,
  },
};

const POLICIES = {
  shipping:
    "Standard UK delivery takes 5-7 business days and is free on orders over £25 (otherwise a flat £3.99 fee applies). Expedited delivery (2-3 days) costs £6.99.",
  returns:
    "Items can be returned within 30 days of delivery for a full refund, provided they're in original condition. Refunds go to the original payment method within 5-7 business days. Return shipping is the customer's responsibility unless the item arrived damaged or was sent in error.",
  password_reset:
    "To reset your password, go to Account > Security > Reset Password. A reset link is emailed and expires after 24 hours.",
};

// Shopify Admin API style order lookup - requires BOTH order_number and the
// email used to place the order (mirrors how real support chat verification works).
// Returns a generic "verification_failed" for either a wrong order id or a
// mismatched email, deliberately not revealing which one was wrong.
function getOrder(orderNumber, email) {
  const order = ORDERS[orderNumber];
  if (!order) return { error: "verification_failed" };
  if (!email || order.email.toLowerCase() !== String(email).toLowerCase()) {
    return { error: "verification_failed" };
  }
  return order;
}

function getPolicy(topic) {
  const key = String(topic || "").toLowerCase().replace(/\s+/g, "_");
  const text = POLICIES[key];
  if (!text) return null;
  return { doc: POLICY_DOC_NAME, section: key, text };
}

// Shopify Admin API style refund - returns "pending", not an instant
// confirmation, mirroring the real async settlement flow (a webhook would
// confirm completion in production).
function createRefund(orderNumber, email, reason) {
  const order = getOrder(orderNumber, email);
  if (order.error) return order;
  if (!order.return_eligible) {
    return {
      refund_status: "declined",
      message: `Order ${orderNumber} is outside the 30-day return window or not yet delivered.`,
    };
  }
  const item = order.line_items[0];
  return {
    refund_status: "pending",
    amount: item.price,
    gateway: "shopify_payments",
    message: `Refund of £${item.price} for "${item.title}" has been initiated (reason: "${reason}"). You'll get a confirmation once it settles.`,
  };
}

// Gorgias style ticket creation - mock human escalation queue.
let ticketCounter = 4820;
function createTicket({ priority, tags, reason, customerEmail }) {
  ticketCounter += 1;
  return {
    ticket_id: `GOR-${ticketCounter}`,
    status: "open",
    queue: "human_support",
    priority: priority || "normal",
    tags: tags || [],
    message: "This has been passed to a member of our team, who'll follow up shortly.",
  };
}

module.exports = { getOrder, getPolicy, createRefund, createTicket, ORDERS, POLICIES, POLICY_DOC_NAME };
