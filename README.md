# crabwise-api

**The API, test runner, video pipeline, social services, and AI coach behind Crabwise, a Rust learning community on Stellar where tutors teach, learners earn XLM for code that passes, and study groups stake on finishing.**

This repo holds the off-chain half of Crabwise: wallet-based authentication, course and video management, the sandbox that runs learners' Rust code, the feed and forum, live chat, the AI coach and crypto news digest, and the indexer that mirrors Soroban events.

![License: MIT](https://img.shields.io/badge/License-MIT-green) ![Network: Stellar](https://img.shields.io/badge/Network-Stellar-blue) ![Runtime: Node.js](https://img.shields.io/badge/Runtime-Node.js-green) ![API: Fastify](https://img.shields.io/badge/API-Fastify-black) ![DB: PostgreSQL](https://img.shields.io/badge/DB-PostgreSQL-blue)

> **Status:** early design and Testnet development. Endpoints and modules below describe the target design. Items marked *planned* are not yet implemented.

**Part of Crabwise:** [crabwise-web](https://github.com/your-org/crabwise-web) · crabwise-api (this repo) · [crabwise-contracts](https://github.com/your-org/crabwise-contracts)

---

## What is Crabwise?

Learning Rust is hard, and most learners quit at the borrow checker. Crabwise connects tutors and learners:

- Tutors publish video courses and run live sessions. Learners buy, **download**, and learn offline.
- Learners write Rust in the browser and **earn XLM when their code passes the tutor's tests**.
- A social feed, forum, and chat keep the community talking.
- Learners can swap assets on Stellar from inside the app.
- An AI coach explains compiler errors, gives hints before answers, and summarises the latest crypto news with sources.

### The two unique features

1. **Proof of Compile.** Challenges pay learners automatically when a sandboxed runner attests that their solution passes the tutor's tests. This backend runs the sandbox and signs the attestations.
2. **Molt Pods.** Small cohorts stake a few XLM against weekly goals. This backend tracks progress, records attestations, and shows each pod's live standings. The contract settles the money.

---

## Architecture

```
Next.js app ──► Fastify API ──► PostgreSQL / Redis
                    │
   ┌────────────────┼──────────────────────────────┐
   ▼                ▼                ▼             ▼
 Runner         Video pipeline    AI service    Indexer
 (sandbox)      (upload, ffmpeg,  (coach, RAG,  (Soroban events
   │             encrypt, store)   news digest)  -> Postgres)
   │                │                │             │
   ▼                ▼                ▼             ▼
 signs result   Object storage    LLM API      Stellar RPC / Horizon
 attestations   (encrypted)       + news feeds + crabwise-contracts
```

| Module | Responsibility |
|---|---|
| `auth` | Wallet login with SEP-10 challenge signing, sessions, and roles (learner, tutor, reviewer, admin) |
| `users` | Profiles, follows, reputation, and notification settings |
| `courses` | Course metadata, lessons, versions, previews, and reviews |
| `videos` | Resumable upload, virus scan, transcoding, encryption, and signed download links |
| `entitlements` | Checks on-chain access (`has_access`) and caches it |
| `sessions` | Booking, availability, reminders, and a video-call link for live sessions |
| `runner` | Runs Rust tests in an isolated sandbox and signs attestations for `CompileVault` |
| `challenges` | Challenge definitions, submissions, and results |
| `pods` | Molt Pod goals, weekly progress, standings, and attestations for `MoltPod` |
| `feed` | Posts, replies, likes, reposts, follows, hashtags, and timelines |
| `forum` | Topic-based threads (ownership, async, Soroban, and so on) with accepted answers |
| `chat` | Direct messages and course rooms over WebSocket |
| `trade` | Quotes and path finding from Horizon for swaps (the user signs in their wallet) |
| `ai` | The coach, retrieval over course material, and the news digest |
| `news` | Ingests and deduplicates crypto news from licensed sources |
| `moderation` | Reports, rate limits, spam checks, and an admin queue |
| `indexer` | Streams contract events into PostgreSQL and extends TTL for active records |
| `notifications` | In-app, email, and push notifications |

```
crabwise-api/
├── apps/
│   ├── api/              # Fastify HTTP + WebSocket server
│   ├── runner/           # Sandbox worker that runs Rust tests
│   ├── video-worker/     # Transcoding and encryption worker
│   ├── ai/               # Coach and news digest service
│   └── indexer/          # Soroban event indexer and TTL keeper
├── packages/
│   ├── db/               # Prisma schema and migrations
│   ├── stellar/          # SEP-10, Horizon and RPC helpers, contract clients
│   ├── shared/           # Types, validation, and logging
│   └── queue/            # Job queues (BullMQ)
├── docker/               # Dockerfiles and sandbox profiles
├── docs/                 # Architecture, runner security, API reference
├── scripts/              # Seed data and local bootstrap
├── docker-compose.yml
├── pnpm-workspace.yaml
└── README.md             <- you are here
```
**Stack:** Node.js, TypeScript, Fastify, Prisma, PostgreSQL, Redis, BullMQ, S3-compatible object storage, FFmpeg, Docker, @stellar/stellar-sdk, Prometheus

---

## Core Services

### Authentication
Users sign in with a Stellar wallet. The API issues a SEP-10 challenge, the wallet signs it, and the API returns a short-lived session. There are no passwords. Roles (learner, tutor, reviewer, admin) are stored in PostgreSQL, and tutor status is cross-checked against `TutorRegistry`.

### Video Pipeline
Tutors upload lessons, learners download them for offline study.

1. **Upload.** Resumable upload (tus protocol) to a staging bucket.
2. **Scan.** Virus and format check.
3. **Transcode.** FFmpeg creates several qualities, including a very low-bandwidth version (about 240p) for data-saver downloads.
4. **Encrypt.** Each video is encrypted with AES-GCM using a per-video key. Keys are held in a key service, never in the bucket.
5. **Download.** A learner with `has_access` receives a short-lived signed URL for the encrypted file, plus a licence key bound to their device for offline playback.

Honest limit: once a video is playing on a device, it cannot be made impossible to copy. Per-learner visible watermarks and licence revocation on refunds (best effort) deter casual sharing, and tutors are told this.

### Runner (Proof of Compile)
The runner executes learner code against a tutor's tests.

- Runs inside an isolated sandbox (gVisor or Firecracker class isolation) with **no network access**
- Fixed limits: CPU time, memory, process count, disk, and output size
- Read-only root filesystem, a vendored allowlist of crates, and a pinned Rust toolchain
- Hidden tests can be added by the tutor, in addition to public ones (planned)
- Output is truncated and sanitised before it is returned to the learner

After a run, the runner builds a **result hash** that commits to the test suite hash, the solution hash, the toolchain version, and the output. A registered runner key signs the result and submits it to `CompileVault.attest`. Anyone with the same inputs can re-run the sandbox and check the hash. Plagiarism checks (code similarity, AI-assisted) run before a reward is claimable, and flagged submissions go to an arbiter.

### Molt Pods
The backend defines each pod's weekly goals (for example, "pass challenges 1 and 2" or "complete lessons 3 to 5"), checks progress, and submits attestations as the curator or runner. Learners see live standings and can contest an attestation inside the contest window. Settlement and payouts are handled by the contract.

### AI Coach and News Digest
| Feature | What it does |
|---|---|
| **Compiler Error Explainer** | Explains a Rust error in plain language and points at the concept (ownership, borrowing, lifetimes) |
| **Hint Ladder** | Gives hints in steps before the full answer. Tutors can restrict the coach to hints only for graded challenges |
| **Course Q&A** | Answers questions using retrieval over course transcripts and the Rust docs, with links back to the lesson |
| **Code Review** | Reviews a learner's code for style, safety, and idiomatic Rust |
| **Study Plan** | Builds a weekly plan from a learner's goal, level, and time |
| **Crypto News Digest** | Summarises the latest crypto and Stellar news with source links and timestamps |
| **Safety** | Does not give financial or trading advice, labels AI summaries, and shows when news data is stale |

The AI never signs transactions, never sets rewards, and never decides a Proof of Compile result. News comes from licensed or permitted feeds and is shown as short summaries with links to the original article.

### Feed, Forum, and Chat
- Short posts, replies, reposts, likes, follows, and hashtags
- Forum threads by topic, with accepted answers and tutor badges
- Direct messages and course rooms over WebSocket (end-to-end encryption is *planned*)
- Tipping posts and tutors with XLM is a plain Stellar payment signed in the user's wallet
- Moderation: reports, rate limits, spam detection, and an admin queue

### Trade
The backend never holds user funds. It provides quotes and path finding from Horizon, an allowlist of vetted assets, trustline helpers, and price-impact and slippage warnings. The user signs the swap in their own wallet. Trading is risky, and nothing in the app is financial advice.

### Indexer
Streams events from the five contracts into PostgreSQL, keeps TTL extended for active courses, purchases, challenges, and pods, and exposes consistent read models to the API.

---

## API

```
# Auth
POST  /v1/auth/challenge                       Get a SEP-10 challenge
POST  /v1/auth/token                           Exchange a signed challenge for a session

# Courses and videos
GET   /v1/courses                              Browse and search courses
GET   /v1/courses/:id                          Course details, lessons, ratings
POST  /v1/courses                              Create a course (tutor)
POST  /v1/courses/:id/lessons                  Add a lesson
POST  /v1/uploads                              Start a resumable video upload (tutor)
GET   /v1/courses/:id/download/:lessonId       Signed download link and licence key (needs access)

# Sessions
GET   /v1/tutors                               Search tutors
GET   /v1/tutors/:address/availability         Open slots
POST  /v1/sessions                             Request a booking

# Proof of Compile
GET   /v1/challenges                           List challenges
GET   /v1/challenges/:id                       Challenge details and public tests
POST  /v1/challenges/:id/run                   Run code against public tests (sandbox, no reward)
POST  /v1/challenges/:id/submit                Submit for a reward-eligible run
GET   /v1/challenges/:id/results/:address      Result and attestation status

# Molt Pods
GET   /v1/pods                                 Open pods
GET   /v1/pods/:id                             Goals, members, standings
POST  /v1/pods/:id/contest                     Contest an attestation

# Social
GET   /v1/feed                                 Home timeline
POST  /v1/posts                                Create a post
POST  /v1/posts/:id/like                       Like or unlike
GET   /v1/forum/topics                         Forum topics
POST  /v1/forum/threads                        Start a thread
WS    /v1/chat                                 Direct messages and course rooms

# AI, news, and trade
POST  /v1/ai/chat                              Ask the coach
POST  /v1/ai/explain-error                     Explain a compiler error
GET   /v1/news                                 Latest crypto news digest
GET   /v1/trade/quote                          Swap quote and path
GET   /v1/trade/assets                         Allowlisted assets
```

---

## Data Model (overview)

| Table | Purpose |
|---|---|
| `users` | Wallet address, handle, roles, and settings |
| `tutors` | Tutor profile and verification mirror |
| `courses`, `lessons`, `lesson_versions` | Course content metadata |
| `videos`, `video_keys` | Video assets and key references |
| `purchases`, `entitlements` | Mirror of on-chain purchases and access |
| `sessions`, `availability` | Live sessions and tutor slots |
| `challenges`, `submissions`, `runs`, `results` | Proof of Compile |
| `pods`, `pod_members`, `pod_progress` | Molt Pods |
| `posts`, `follows`, `likes`, `threads`, `messages` | Social data |
| `news_items`, `news_digests` | Ingested news and generated digests |
| `reports`, `moderation_actions` | Moderation |
| `chain_events` | Raw events from the indexer |

---

## Getting Started

### Prerequisites
- Node.js 20 or later
- pnpm 9 or later
- Docker and Docker Compose
- A funded Stellar Testnet account (`stellar keys generate --fund`)
- Optional: LLM API key, news feed credentials

### Install
```bash
git clone https://github.com/your-org/crabwise-api.git
cd crabwise-api
pnpm install
cp .env.example .env
docker compose up -d postgres redis minio
pnpm --filter @crabwise/db migrate
pnpm --filter @crabwise/db seed
```

### Environment variables (key ones)
```
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
STELLAR_NETWORK=testnet
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
HORIZON_URL=https://horizon-testnet.stellar.org
CONTRACT_TUTOR_REGISTRY=...
CONTRACT_COURSE_MARKET=...
CONTRACT_COMPILE_VAULT=...
CONTRACT_MOLT_POD=...
RUNNER_SIGNING_KEY=...          # Held in a KMS in production
S3_ENDPOINT=...
LLM_API_KEY=...                 # Optional
NEWS_FEED_SOURCES=...           # Optional
```

### Run in development
```bash
pnpm dev                                  # API + workers
pnpm --filter @crabwise/api dev           # API only
pnpm --filter @crabwise/runner dev        # Runner with the local sandbox profile
pnpm --filter @crabwise/indexer start:testnet
```

### Test
```bash
pnpm test             # Unit and integration tests
pnpm test:runner      # Sandbox escape and limit tests
pnpm lint
```

---

## Security

| Risk | Mitigation |
|---|---|
| **Sandbox escape or abuse** | No network, strong isolation, strict limits, read-only filesystem, vendored crates, and dedicated runner machines |
| **Runner key theft** | The signing key is held in a KMS, rotated by admin multisig on-chain, and capped by challenge budgets |
| **Video piracy** | Encryption at rest, signed expiring links, device-bound keys, watermarks, and licence revocation on refunds (best effort) |
| **Reward farming** | Access-linked challenges, plagiarism checks, rate limits, and one reward per learner per challenge |
| **Spam and abuse** | Rate limits, reports, moderation queue, and account reputation |
| **AI misuse or errors** | Hint-only mode for graded work, citations for news and course answers, and no financial advice |
| **Personal data** | Minimal data, encrypted secrets, and deletion on request |

- Secrets are never committed. Use `.env` locally and a secrets manager in production.
- Learner code and tests are treated as untrusted input at every step.
- Responsible disclosure: `security@your-domain.example`

---

## Roadmap

| Phase | Milestone |
|---|---|
| 1 | Auth, courses, uploads, and entitlement checks |
| 2 | Video pipeline with encrypted offline downloads |
| 3 | Runner and Proof of Compile attestations on Testnet |
| 4 | Feed, forum, chat, and moderation |
| 5 | AI coach and news digest, Molt Pods tracking, trade quotes |
| 6 | Security review, load testing, and Mainnet launch |

---

## Planned Issues for Contributors

| Type | Examples |
|---|---|
| **Bug fixes** | Upload resume edge cases, SEP-10 expiry handling, timeline pagination, sandbox timeout handling |
| **New features** | Course search filters, tutor availability calendar, notification emails, hashtag trending, forum accepted answers |
| **Runner** | New test-harness templates, hidden-test support, plagiarism similarity checks, resource-limit tests |
| **AI** | Evaluation set for error explanations, hint-ladder prompts, news deduplication, citation formatting |
| **Testing** | Integration tests with a local Stellar network, load tests for the feed, sandbox escape tests |
| **Documentation** | API reference, runner security guide, deployment guide, architecture diagrams |
| **Good first issues** | Typos, error messages, seed data, OpenAPI examples, extra validation |

Every issue has a description, acceptance criteria, and a pointer to the relevant files.

---

## Contributing

```bash
git checkout -b feat/your-feature
pnpm test && pnpm lint
# open a PR against main
```
See `CONTRIBUTING.md` and `docs/architecture.md`.

## License
MIT, 2026 Crabwise Contributors

---

*Built on Stellar. Learn Rust, wisely.*
