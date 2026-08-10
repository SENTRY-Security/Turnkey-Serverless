import { randomBytes } from "node:crypto";
import { EgressHttpError } from "./auth.js";

export interface TransportCredentials {
  loginId: string;
  loginPassword: string;
}

interface SessionRecord {
  profile: string;
  credentials: TransportCredentials;
  expiresAt: number;
}

export class EphemeralSessionStore {
  readonly #sessions = new Map<string, SessionRecord>();

  constructor(private readonly maximumTtlSeconds: number) {}

  issue(profile: string, credentials: TransportCredentials, requestedTtlSeconds?: number): {
    token: string;
    expiresAt: string;
  } {
    this.evictExpired();
    const ttl = Math.min(this.maximumTtlSeconds, Math.max(30, requestedTtlSeconds ?? this.maximumTtlSeconds));
    const token = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + ttl * 1000;
    this.#sessions.set(token, { profile, credentials, expiresAt });
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  consume(token: string, profile: string): TransportCredentials {
    this.evictExpired();
    const session = this.#sessions.get(token);
    if (!session || session.profile !== profile) {
      throw new EgressHttpError(401, "EGRESS_SESSION_INVALID", "Egress session is missing, expired, or invalid");
    }
    this.#sessions.delete(token);
    return session.credentials;
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [token, session] of this.#sessions) {
      if (session.expiresAt <= now) {
        this.#sessions.delete(token);
      }
    }
  }
}
