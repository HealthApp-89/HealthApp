// lib/time/iana-codes.ts
//
// Compact display labels for the header chip. IANA names like "Asia/Dubai"
// are too long; this maps the common ones to 3-letter codes. Unknown zones
// fall back to the city portion uppercased.

const KNOWN: Record<string, string> = {
  "Asia/Dubai": "DXB",
  "Asia/Tokyo": "TYO",
  "Asia/Shanghai": "SHA",
  "Asia/Hong_Kong": "HKG",
  "Asia/Singapore": "SIN",
  "Asia/Kolkata": "DEL",
  "Asia/Bangkok": "BKK",
  "Asia/Seoul": "ICN",
  "Europe/London": "LON",
  "Europe/Paris": "PAR",
  "Europe/Berlin": "BER",
  "Europe/Madrid": "MAD",
  "Europe/Rome": "ROM",
  "Europe/Amsterdam": "AMS",
  "Europe/Zurich": "ZRH",
  "Europe/Istanbul": "IST",
  "America/New_York": "NYC",
  "America/Los_Angeles": "LAX",
  "America/Chicago": "CHI",
  "America/Toronto": "YYZ",
  "America/Mexico_City": "MEX",
  "America/Sao_Paulo": "SAO",
  "Australia/Sydney": "SYD",
  "Australia/Melbourne": "MEL",
  "Africa/Cairo": "CAI",
  "Africa/Johannesburg": "JNB",
  "Pacific/Auckland": "AKL",
  "UTC": "UTC",
};

export function ianaToCode(tz: string): string {
  if (KNOWN[tz]) return KNOWN[tz];
  // Fallback: take the city portion, drop underscores, uppercase, max 4 chars.
  const city = tz.split("/").pop() ?? tz;
  return city.replace(/_/g, "").toUpperCase().slice(0, 4);
}
