// ============================================================
// Retrieval evaluation corpus
// ============================================================
//
// A hand-labelled set for measuring recall quality. Deliberately small enough
// to run in under a minute and to reason about when a case fails, but large
// enough that BM25's IDF term is meaningful — below roughly 20 documents it is
// degenerate and lexical scores carry no information.
//
// The corpus is built to punish both failure modes we have actually seen:
//
//   - LEXICAL TRAPS: a distractor shares a distinctive word with the query but
//     not its meaning ("incident" appears in a database note; the query asks
//     who handles incidents).
//   - SEMANTIC GAPS: the gold answer shares no vocabulary with the query at all
//     ("container strategy" → a memory that only says "Kubernetes").
//
// A system that only does keyword matching fails the semantic gaps. One that
// only does vector search tends to fail the precise lexical cases. The mix is
// the point.

export interface EvalMemory {
  id: string;
  content: string;
}

export interface EvalQuery {
  query: string;
  /** IDs that are a correct answer. Most have exactly one. */
  gold: string[];
  /** What this case is testing, for reading failures. */
  probes: 'semantic' | 'lexical' | 'lexical-trap' | 'paraphrase' | 'multi';
}

export const MEMORIES: EvalMemory[] = [
  // ── Engineering: languages, tooling ──
  { id: 'lang-1', content: 'Juan Carlos prefers TypeScript over Python for backend services' },
  { id: 'lang-2', content: 'The data science team writes everything in Python with pandas' },
  { id: 'tool-1', content: 'We use pnpm as the package manager, never npm or yarn' },
  { id: 'tool-2', content: 'Formatting is handled by biome, which replaced prettier and eslint' },
  { id: 'tool-3', content: 'Type checking runs as a separate CI step with tsc --noEmit' },

  // ── Infrastructure ──
  { id: 'infra-1', content: 'The team decided to migrate the gateway to Kubernetes in Q3' },
  { id: 'infra-2', content: 'The staging environment mirrors production except for the CDN' },
  { id: 'infra-3', content: 'Everything runs on ARM instances since the cost review last spring' },
  { id: 'infra-4', content: 'Terraform state lives in an S3 bucket with DynamoDB locking' },
  { id: 'infra-5', content: 'We removed the last bare-metal server in February' },

  // ── Databases ──
  { id: 'db-1', content: 'Postgres connection pool was raised to 40 after the incident' },
  { id: 'db-2', content: 'Read replicas lag by about 200ms under normal load' },
  { id: 'db-3', content: 'Migrations are applied by hand during the Thursday window, never automatically' },
  { id: 'db-4', content: 'Redis is used only for rate limiting, not as a cache' },

  // ── People and roles ──
  { id: 'people-1', content: 'Marta is the SRE lead and owns the on-call rotation' },
  { id: 'people-2', content: 'Diego reviews every change that touches billing code' },
  { id: 'people-3', content: 'Ana joined in March and works on the mobile client' },
  { id: 'people-4', content: 'The platform team is four engineers and one designer' },

  // ── Process ──
  { id: 'proc-1', content: 'Release notes are published every second Thursday' },
  { id: 'proc-2', content: 'Pull requests need one approval, two if they touch authentication' },
  { id: 'proc-3', content: 'Retrospectives are written down but the meeting itself was dropped' },
  { id: 'proc-4', content: 'Anything shipped on a Friday needs a rollback plan attached' },
  { id: 'proc-5', content: 'Incident reviews are blameless and always produce written follow-ups' },

  // ── Product ──
  { id: 'prod-1', content: 'The free tier is capped at 1000 requests per day' },
  { id: 'prod-2', content: 'Enterprise customers get a dedicated Slack channel' },
  { id: 'prod-3', content: 'The onboarding flow was cut from nine screens to four' },
  { id: 'prod-4', content: 'Churn is highest in the second month, not the first' },

  // ── Personal preferences ──
  { id: 'pref-1', content: 'Juan Carlos wants short answers and no preamble' },
  { id: 'pref-2', content: 'Meetings before 10am are declined by default' },
  { id: 'pref-3', content: 'He reads documentation in English even when writing Spanish' },
  { id: 'pref-4', content: 'Dark mode everywhere, and a 14 inch screen at most' },

  // ── Distractors sharing vocabulary with queries but not meaning ──
  { id: 'noise-1', content: 'Coffee machine on floor 3 is broken again' },
  { id: 'noise-2', content: 'The office moved to a new building near the station' },
  { id: 'noise-3', content: 'Parking passes are renewed every January' },
  { id: 'noise-4', content: 'The fire drill is scheduled for the last Tuesday of the quarter' },
  { id: 'noise-5', content: 'Someone left a bicycle in the server room again' },
  { id: 'noise-6', content: 'The plant near the window needs watering twice a week' },
  { id: 'noise-7', content: 'Lunch is catered on Wednesdays only' },
  { id: 'noise-8', content: 'The printer on the second floor jams with thick paper' },

  // ── Filler with overlapping engineering vocabulary ──
  { id: 'fill-1', content: 'The build cache was moved to a shared volume last month' },
  { id: 'fill-2', content: 'Log retention is thirty days for application logs' },
  { id: 'fill-3', content: 'Feature flags are cleaned up quarterly, usually badly' },
  { id: 'fill-4', content: 'The mobile client caches responses for six hours' },
  { id: 'fill-5', content: 'API versioning uses a header, not a URL prefix' },
  { id: 'fill-6', content: 'Error budgets are reviewed at the start of each quarter' },
  { id: 'fill-7', content: 'Secrets are rotated automatically every ninety days' },
  { id: 'fill-8', content: 'The load test suite has not been run since the rewrite' },
  { id: 'fill-9', content: 'Documentation lives in the repo, not in the wiki' },
  { id: 'fill-10', content: 'The design system was forked and never merged back' },
];

export const QUERIES: EvalQuery[] = [
  // Semantic: gold shares little or no vocabulary with the query.
  { query: 'what is our container strategy?', gold: ['infra-1'], probes: 'semantic' },
  { query: 'which programming language for the API layer?', gold: ['lang-1'], probes: 'semantic' },
  { query: 'how do we keep people from hammering the API?', gold: ['db-4', 'prod-1'], probes: 'semantic' },
  { query: 'what hardware do the servers use?', gold: ['infra-3'], probes: 'semantic' },
  { query: 'how should I talk to Juan Carlos?', gold: ['pref-1'], probes: 'semantic' },
  { query: 'is anyone awake at 8 in the morning?', gold: ['pref-2'], probes: 'semantic' },
  { query: 'when can I expect the changelog?', gold: ['proc-1'], probes: 'semantic' },
  { query: 'what happens if I deploy at the end of the week?', gold: ['proc-4'], probes: 'semantic' },

  // Lexical traps: a distractor shares a distinctive word with the query.
  { query: 'who handles incidents?', gold: ['people-1'], probes: 'lexical-trap' },
  { query: 'who should review a payment change?', gold: ['people-2'], probes: 'lexical-trap' },
  { query: 'what caches things?', gold: ['fill-4', 'db-4'], probes: 'lexical-trap' },
  { query: 'where is the state stored?', gold: ['infra-4'], probes: 'lexical-trap' },

  // Lexical: the distinctive term appears verbatim.
  { query: 'pnpm', gold: ['tool-1'], probes: 'lexical' },
  { query: 'biome formatting', gold: ['tool-2'], probes: 'lexical' },
  { query: 'terraform state locking', gold: ['infra-4'], probes: 'lexical' },
  { query: 'read replica lag', gold: ['db-2'], probes: 'lexical' },
  { query: 'postgres connection pool', gold: ['db-1'], probes: 'lexical' },

  // Paraphrase: same meaning, different words.
  { query: 'how similar is the test environment to the real one?', gold: ['infra-2'], probes: 'paraphrase' },
  { query: 'how many approvals does a merge need?', gold: ['proc-2'], probes: 'paraphrase' },
  { query: 'do we still hold retros?', gold: ['proc-3'], probes: 'paraphrase' },
  { query: 'when do customers usually leave?', gold: ['prod-4'], probes: 'paraphrase' },
  { query: 'how big is the platform group?', gold: ['people-4'], probes: 'paraphrase' },
  { query: 'how are schema changes rolled out?', gold: ['db-3'], probes: 'paraphrase' },

  // Multi: more than one memory is a legitimate answer.
  { query: 'what do we know about the mobile app?', gold: ['people-3', 'fill-4'], probes: 'multi' },
  { query: 'what are the rules around shipping code?', gold: ['proc-2', 'proc-4', 'proc-1'], probes: 'multi' },
];
