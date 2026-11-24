/** Node's `os` for Colyseus in a tab: one core, so the matchmaker picks in-memory presence */
export default { cpus: (): unknown[] => [], hostname: (): string => 'browser' };
