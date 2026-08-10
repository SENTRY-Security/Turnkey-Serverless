import { describe, expect, it } from "vitest";
import { EgressHttpError } from "../src/egress/auth.js";
import { EphemeralSessionStore } from "../src/egress/sessions.js";

describe("Linode ephemeral sessions", () => {
  it("binds a session to one profile and consumes it exactly once", () => {
    const store = new EphemeralSessionStore(300);
    const credentials = { loginId: "transport-id", loginPassword: "transport-password" };
    const session = store.issue("company-test", credentials, 60);
    expect(store.consume(session.token, "company-test")).toEqual(credentials);
    expect(() => store.consume(session.token, "company-test")).toThrowError(
      expect.objectContaining<Partial<EgressHttpError>>({ code: "EGRESS_SESSION_INVALID" }),
    );
  });

  it("does not allow a token to cross profiles", () => {
    const store = new EphemeralSessionStore(300);
    const session = store.issue("company-a", { loginId: "id", loginPassword: "pw" });
    expect(() => store.consume(session.token, "company-b")).toThrow(EgressHttpError);
  });
});
