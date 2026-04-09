// E.164 phone number, e.g. "+9611234567". Without the "whatsapp:" prefix.
export type Phone = string;

export interface FamilyMember {
  name: string;
  joined_at: number;
  is_admin: boolean;
}

export type CheckInStatus = "safe" | "help";

export interface IncidentResponse {
  status: CheckInStatus;
  at: number;
}

export interface IncidentState {
  id: string;
  triggered_at: number;
  triggered_by: Phone;
  responses: Record<Phone, IncidentResponse>;
  // Twilio MessageSids we've already processed, for webhook-retry dedupe.
  processed_webhooks: string[];
  fired: boolean;
  cancelled: boolean;
}

export interface Env {
  // KV
  FAMILY: KVNamespace;
  RATE_LIMIT: KVNamespace;
  RECENT_INCIDENTS: KVNamespace;
  AUTH_FAIL_COUNTS: KVNamespace;

  // Durable Object
  INCIDENT: DurableObjectNamespace<import("./incident").Incident>;

  // Secrets
  ADMIN_PIN: string;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_FROM: string;
  TWILIO_TEMPLATE_SID: string;
  MAX_ALERTS_PER_MONTH?: string;
}
