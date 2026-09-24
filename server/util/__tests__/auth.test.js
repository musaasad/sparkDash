import { test } from "node:test";
import assert from "node:assert/strict";
import { extractBearer } from "../../auth.js";

test("extractBearer reads the Bearer header", () => {
  assert.equal(extractBearer({ headers: { authorization: "Bearer  abc123 " } }), "abc123");
});

test("extractBearer reads Express req.query.token", () => {
  assert.equal(extractBearer({ headers: {}, query: { token: "q1" } }), "q1");
});

test("extractBearer parses ?token= from a raw WS-upgrade req.url (no req.query)", () => {
  // The WebSocketServer verifyClient gets a plain http.IncomingMessage where
  // Express has NOT populated req.query; the browser sends ?token= on the socket.
  assert.equal(extractBearer({ headers: {}, url: "/ws?token=tok-99" }), "tok-99");
  assert.equal(extractBearer({ headers: {}, url: "/ws?other=1&token=tok-7&x=2" }), "tok-7");
});

test("extractBearer returns empty when no token is present", () => {
  assert.equal(extractBearer({ headers: {}, url: "/ws" }), "");
  assert.equal(extractBearer({ headers: {} }), "");
});