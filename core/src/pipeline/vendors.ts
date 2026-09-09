/**
 * Known-vendor table for `external` references (parser §4.1). Scope §in-scope
 * names Cohere and Anthropic; the rest are common enough that a bare URL to
 * them should still land on a named node. Data, not logic: nothing here
 * decides anything, it only supplies labels and hostname lookups.
 */
export interface Vendor {
  readonly id: string;
  readonly label: string;
  readonly hosts: readonly string[];
}

export const KNOWN_VENDORS: readonly Vendor[] = [
  { id: "cohere", label: "Cohere", hosts: ["api.cohere.ai", "api.cohere.com"] },
  { id: "anthropic", label: "Anthropic", hosts: ["api.anthropic.com"] },
  { id: "openai", label: "OpenAI", hosts: ["api.openai.com"] },
  { id: "stripe", label: "Stripe", hosts: ["api.stripe.com"] },
  { id: "aws", label: "AWS", hosts: ["amazonaws.com"] },
  { id: "github", label: "GitHub", hosts: ["api.github.com"] },
  { id: "slack", label: "Slack", hosts: ["slack.com", "hooks.slack.com"] },
  { id: "sendgrid", label: "SendGrid", hosts: ["api.sendgrid.com"] },
  { id: "twilio", label: "Twilio", hosts: ["api.twilio.com"] },
];

export function vendorById(id: string): Vendor | null {
  return KNOWN_VENDORS.find((v) => v.id === id) ?? null;
}

/** Longest-suffix hostname match, so `s3.us-east-1.amazonaws.com` finds aws. */
export function vendorByHost(host: string): Vendor | null {
  const h = host.toLowerCase();
  let best: Vendor | null = null;
  let bestLen = 0;
  for (const v of KNOWN_VENDORS) {
    for (const known of v.hosts) {
      if ((h === known || h.endsWith(`.${known}`)) && known.length > bestLen) {
        best = v;
        bestLen = known.length;
      }
    }
  }
  return best;
}
