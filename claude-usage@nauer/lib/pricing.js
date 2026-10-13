// Anthropic API list prices, USD per million tokens.
//
// `read` is the cache-read price. Cache writes are billed at 1.25x the input
// price for the 5-minute TTL and 2x for the 1-hour TTL. Rows are matched in
// order against the model id, so more specific patterns come first.
//
// Pure module: imported both by the shell process and by the scanner, which
// runs under plain `gjs -m`.

export const PRICES = [
    {match: /fable-5-1|mythos-5-1/, family: 'Fable', input: 10, output: 50, read: 0.25},
    {match: /fable-5|mythos-5/, family: 'Fable', input: 10, output: 50, read: 1.0},
    {match: /opus-5-5/, family: 'Opus', input: 4, output: 20, read: 0.2},
    {match: /opus-5/, family: 'Opus', input: 5, output: 25, read: 0.5},
    {match: /opus-4-[5-9]/, family: 'Opus', input: 5, output: 25, read: 0.5},
    {match: /opus-4|3-opus/, family: 'Opus', input: 15, output: 75, read: 1.5},
    {match: /sonnet-5/, family: 'Sonnet', input: 2, output: 10, read: 0.2},
    {match: /sonnet/, family: 'Sonnet', input: 3, output: 15, read: 0.3},
    // Haiku 5.5 doubles in price above 100K prompt tokens (see `long`).
    {match: /haiku-5/, family: 'Haiku', input: 0.1, output: 0.5, read: 0.01,
        long: {threshold: 100_000, input: 0.5, output: 2.5, read: 0.05}},
    {match: /haiku-4/, family: 'Haiku', input: 1, output: 5, read: 0.1},
    {match: /3-5-haiku|haiku-3-5/, family: 'Haiku', input: 0.8, output: 4, read: 0.08},
    {match: /haiku/, family: 'Haiku', input: 0.25, output: 1.25, read: 0.03},
];

// Unknown Claude models are priced like the current Sonnet so they still
// show up; non-Claude models routed through Claude Code (proxies, gateways)
// have no Anthropic list price and count as free.
const FALLBACK = {family: 'Other', input: 2, output: 10, read: 0.2};
const NON_CLAUDE = {family: 'Other', input: 0, output: 0, read: 0};

const FAST_MULTIPLIER = 2;

export function priceFor(model) {
    const id = (model ?? '').toLowerCase();
    return PRICES.find(p => p.match.test(id)) ?? (id.includes('claude') ? FALLBACK : NON_CLAUDE);
}

export function familyOf(model) {
    return priceFor(model).family;
}

/**
 * Cost in USD of one API response.
 *
 * @param {string} model
 * @param {{input: number, output: number, write5m: number, write1h: number,
 *          read: number, fast?: boolean}} u token counts
 * @returns {number}
 */
export function costOf(model, u) {
    let p = priceFor(model);
    const prompt = u.input + u.write5m + u.write1h + u.read;
    if (p.long && prompt > p.long.threshold)
        p = {...p, ...p.long};

    const usd = (
        u.input * p.input +
        u.output * p.output +
        u.write5m * p.input * 1.25 +
        u.write1h * p.input * 2 +
        u.read * p.read
    ) / 1_000_000;
    return u.fast ? usd * FAST_MULTIPLIER : usd;
}

// Monthly subscription prices, USD per seat.
export const PLANS = {
    'pro': {name: 'Pro', price: 20},
    'max5': {name: 'Max 5×', price: 100},
    'max20': {name: 'Max 20×', price: 200},
    'team-standard': {name: 'Team', price: 30},
    'team-premium': {name: 'Team Premium', price: 150},
    'enterprise': {name: 'Enterprise', price: 0},
    'custom': {name: 'Custom', price: 0},
};

/**
 * Work out the plan from the OAuth profile and/or credentials file.
 *
 * @param {object} profile `/api/oauth/profile` response, may be null
 * @param {object} creds `claudeAiOauth` from the credentials file, may be null
 * @returns {string|null} a key of PLANS
 */
export function detectPlan(profile, creds) {
    const org = profile?.organization ?? {};
    const tier = (org.rate_limit_tier ?? creds?.rateLimitTier ?? '').toLowerCase();
    const type = (org.organization_type ?? creds?.subscriptionType ?? '').toLowerCase();

    if (type.includes('enterprise'))
        return 'enterprise';
    if (type.includes('team'))
        return (org.seat_tier ?? '').includes('premium') ? 'team-premium' : 'team-standard';
    if (tier.includes('20x'))
        return 'max20';
    if (type.includes('max') || tier.includes('max') || profile?.account?.has_claude_max)
        return 'max5';
    if (type.includes('pro') || profile?.account?.has_claude_pro)
        return 'pro';
    return null;
}
