# GridWise LLM — Smart Campus Energy Optimization API

BUP CSE Fest 2026 Hackathon · Online Preliminary Round

An HTTP API that reads 1–3 free-text campus operator notes plus a 24-hour energy
scenario, uses a language model to turn those notes into machine-checkable directives,
validates that interpretation deterministically, and returns a cost-minimal 24-hour
schedule that satisfies every applicable directive and every GridWise energy rule.

---

## 1. Problem

BUP's campus draws electricity from the grid, a rooftop solar array, and a battery,
with demand, solar availability and tariff all varying hour by hour. Campus operators
also send short natural-language notes describing temporary conditions — a panel wash,
a charger outage, a feeder limit — that change what the schedule is allowed to do.
This service interprets those notes, applies them as hard constraints, and returns the
cheapest valid 24-hour operating plan.

---

## 2. Architecture

```
POST /optimize-energy
        │
        ▼
┌───────────────────┐   operator notes + battery context
│ InterpreterService│   Google Gemini · temperature 0 · JSON response mode
│      (LLM)        │   retries, key rotation, model fallback, response cache
└─────────┬─────────┘
          │  untrusted structured directives
          ▼
┌───────────────────┐   repair  : sort/dedupe hours, "20" → 0.2, clamp to capacity
│ GuardrailsService │   validate: 6 allowed types, note mapping, shapes, ranges
│  (deterministic)  │   a directive that cannot be trusted is rejected, never guessed
└─────────┬─────────┘
          │  validated directives
          ▼
┌───────────────────┐   effective solar, charge/discharge windows,
│  ConstraintModel  │   reserve floors, grid caps — one shared picture
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐   linear program (javascript-lp-solver)
│  OptimizerService │   minimise Σ grid_kwh[h] × tariff[h]
└─────────┬─────────┘
          │  24-hour plan
          ▼
┌───────────────────┐   final replay: energy balance, effective solar, battery
│  VerifierService  │   bounds and rates, directive windows, end-of-day neutrality
└─────────┬─────────┘
          │  verified plan
          ▼
    response: directive_interpretation + hourly_plan + totals recalculated
              from hourly_plan + plan_summary
```

**The language model is in the interpretation path, not decoration.** The
`directive_interpretation` the optimizer consumes is produced by Gemini from the raw
note text. Deterministic code never re-derives a directive from note wording on the
primary path — it only validates, applies, and verifies.

---

## 3. Setup

Requires **Node.js 20 or newer** (developed on Node 24) and a free Google AI Studio
API key.

```bash
git clone <your-repository-url>
cd gridwise-api
cp .env.example .env
```

Open `.env` and set `GEMINI_API_KEY` to your key from
[aistudio.google.com/apikey](https://aistudio.google.com/apikey). Then:

```bash
npm install
npm run build
```

### Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `GEMINI_API_KEY` | **yes** | — | Google AI Studio API key. |
| `GEMINI_API_KEYS` | no | — | Comma-separated keys, rotated round-robin to multiply the per-key rate limit. Overrides `GEMINI_API_KEY`. |
| `PORT` | no | `8000` | HTTP port; the service binds `0.0.0.0`. |
| `GEMINI_MODEL` | no | `gemini-2.5-flash` | Primary interpretation model. |
| `GEMINI_FALLBACK_MODELS` | no | see `.env.example` | Comma-separated models tried on a rate-limit or overload response. |
| `GEMINI_THINKING_BUDGET` | no | `0` | Thinking tokens. `0` keeps p95 latency low; raise it to trade latency for reasoning depth. |
| `LLM_TIMEOUT_MS` | no | `8000` | Per-attempt model timeout. |
| `LLM_TOTAL_BUDGET_MS` | no | `20000` | Hard ceiling on all interpretation attempts, keeping the request inside the judge's 30 s limit. |
| `LLM_MAX_ATTEMPTS` | no | `4` | Interpretation attempts before the failure path. |

No secret values are committed. `.env` is git-ignored; `.env.example` contains
placeholders only; the Docker image contains no baked-in credentials.

---

## 4. Run

```bash
# development, with reload
npm run start:dev

# production
npm run build
node dist/main
```

The service prints `GridWise API listening on 0.0.0.0:8000` when ready, and `/health`
answers within a second of that line.

---

## 5. Test `GET /health`

```bash
curl http://localhost:8000/health
```

```json
{ "status": "ok" }
```

---

## 6. Test `POST /optimize-energy`

Public sample case SAMPLE-02, abbreviated for readability — the full 24-hour body is in
[`sample-cases/public-sample-cases.json`](sample-cases/public-sample-cases.json):

```bash
curl -s -X POST http://localhost:8000/optimize-energy \
  -H 'content-type: application/json' \
  -d '{
    "scenario_id": "GRID-101",
    "operator_notes": [
      "The battery charger will be isolated from 2 AM until 5 AM for electrical maintenance."
    ],
    "hours": [
      {"hour": 0, "demand_kwh": 180, "solar_kwh": 0, "tariff_bdt_per_kwh": 7}
      /* ... 22 more entries ... */,
      {"hour": 23, "demand_kwh": 200, "solar_kwh": 0, "tariff_bdt_per_kwh": 9}
    ],
    "battery": {
      "capacity_kwh": 500, "initial_energy_kwh": 200, "minimum_energy_kwh": 50,
      "max_charge_kwh_per_hour": 100, "max_discharge_kwh_per_hour": 100
    }
  }'
```

Response shape:

```json
{
  "scenario_id": "GRID-101",
  "directive_interpretation": [
    {
      "note_index": 0,
      "applies": true,
      "directive_type": "no_charge_window",
      "structured_adjustment": { "hours": [2, 3, 4] },
      "explanation": "Battery charging is unavailable during maintenance."
    }
  ],
  "hourly_plan": [
    {
      "hour": 0,
      "grid_kwh": 230,
      "solar_used_kwh": 0,
      "battery_action": "charge",
      "battery_kwh": 50,
      "battery_energy_after_kwh": 250
    }
  ],
  "total_grid_kwh": 2915,
  "total_cost_bdt": 42885,
  "peak_grid_kwh": 180,
  "plan_summary": "Applied a no-charge window in hours 2, 3, 4; the plan charges ..."
}
```

### Run the whole public sample pack

With the service running on port 8000:

```bash
npm run test:samples
```

Every case is POSTed, and the response is replayed against the **published ground-truth
directives** — schema, directive shape and order, energy balance, effective solar,
battery bounds and rate limits, directive windows, end-of-day neutrality, recalculated
totals, and cost versus the reference optimum. Expected output:

```
10/10 valid, 10/10 interpretation matches, mean cost quality 1.0000
```

Point it at a deployed service with `BASE_URL`:

```bash
BASE_URL=https://your-service.example.com npm run test:samples
```

---

## 7. Docker

The published fallback image needs no build step:

```bash
docker pull <registry>/gridwise-api:<tag>
docker run --rm -p 8000:8000 -e GEMINI_API_KEY=your_key <registry>/gridwise-api:<tag>
curl http://localhost:8000/health
```

To build it locally:

```bash
docker build -t gridwise-api:latest .
docker run --rm -p 8000:8000 -e GEMINI_API_KEY=your_key gridwise-api:latest
```

Or with Compose (reads `GEMINI_API_KEY` from your environment or `.env`):

```bash
docker compose up --build
```

The image is a multi-stage build on `node:22-alpine`, runs as the non-root `node` user,
exposes port 8000, binds `0.0.0.0`, declares a `HEALTHCHECK` against `/health`, and
contains **no credentials** — the key must be supplied at runtime.

---

## 8. LLM

| Item | Value |
|---|---|
| Provider | Google AI Studio (Gemini API) |
| SDK | `@google/genai` |
| Primary model | `gemini-2.5-flash` (configurable via `GEMINI_MODEL`) |
| Decoding | `temperature: 0`, `topP: 1`, `responseMimeType: application/json` |
| Role | Converts each operator note into one structured directive entry |

The model receives a system prompt carrying the exact contract — the six allowed
directive types and their shapes, the start-inclusive/end-exclusive whole-hour window
rule, the remaining-fraction meaning of `factor`, wrap-around and all-day windows,
share-of-capacity reserve conversion, and the relevance rule for distractor notes —
plus worked examples spanning each directive family. The scenario's battery object is
included in the user prompt so a note like *"keep at least 50% of capacity in reserve"*
can be converted to an absolute kWh figure.

**Guardrails run after the model and before the optimizer.** See
[`src/optimize/guardrails.service.ts`](src/optimize/guardrails.service.ts): cosmetic
deviations are repaired deterministically (hours sorted and deduplicated, a factor of
`20` read as `0.2`, a reserve clamped to capacity, stray fields dropped), and anything
that cannot be trusted — an unsupported directive type, a missing note, a malformed
shape, an out-of-range hour — is rejected. The service never invents a directive.

**Failure path.** If the model is unreachable or unusable after every retry, a
deterministic rule-based interpreter
([`src/optimize/fallback-interpreter.service.ts`](src/optimize/fallback-interpreter.service.ts))
produces the directives instead, and they pass through exactly the same guardrails.
This exists so that a provider outage degrades the answer rather than taking the
service down; it is **not** the primary path and is never used while the model is
answering. It reproduces the published ground truth on all ten public cases, and
returns `no_op` rather than guessing when it does not recognise a note.

---

## 9. Optimizer

Linear program solved with [`javascript-lp-solver`](https://www.npmjs.com/package/javascript-lp-solver).

**Variables** (per hour *h* = 0…23): `solar_h`, `charge_h`, `discharge_h`, all ≥ 0.

`grid_h` and `batt_h` are eliminated algebraically rather than carried as variables:

```
grid_h = demand_h + charge_h − solar_h − discharge_h      (≥ 0)
batt_h = initial_energy + Σ_{k ≤ h} (charge_k − discharge_k)
```

That removes 48 variables and 48 equality constraints, leaving 72 variables and a
single equality — the same optimum with markedly better numerical behaviour in a
pure-JavaScript simplex.

**Objective** — minimise `Σ grid_h × tariff_h`, plus a 1e-6 BDT/kWh cycling penalty
that breaks cost-neutral degenerate optima where the solver would otherwise charge and
discharge in the same hour (unrepresentable in the single `battery_action` field). The
penalty cannot move the real optimum by a meaningful fraction of the 0.01 BDT tolerance.

**Constraints**

| Constraint | Form |
|---|---|
| Solar limit | `solar_h ≤ effective_solar_h` |
| Grid non-negativity | `demand_h + charge_h − solar_h − discharge_h ≥ 0` |
| Charge rate | `charge_h ≤ max_charge_kwh_per_hour` (0 inside a `no_charge_window`) |
| Discharge rate | `discharge_h ≤ max_discharge_kwh_per_hour` (0 inside a `no_discharge_window`) |
| Battery capacity | `batt_h ≤ capacity_kwh` |
| Battery floor | `batt_h ≥ max(minimum_energy_kwh, active reserve)` |
| Grid cap | `grid_h ≤ max_grid_kwh` inside a `max_grid_window` |
| End-of-day neutrality | `Σ charge − Σ discharge = 0` |

**Post-processing** — simultaneous charge/discharge is netted to a single action, solar
use is maximised up to the effective limit (which only lowers grid import and cost),
values are rounded to six decimals, and a sub-milli-kWh rounding drift is absorbed in
one hour so `battery_energy_after_kwh[23]` lands exactly on `initial_energy_kwh`.

**Result.** On all ten public cases the LP reproduces the published reference optimum
exactly (mean cost quality 1.0000).

---

## 10. Tests

```bash
npm test              # 158 unit + e2e tests (no API key, no network)
npm run test:unit     # guardrails, optimizer, verifier, interpreter, pipeline, filter
npm run test:e2e      # full HTTP stack with a stubbed model
npm run test:optimizer  # optimizer vs. the 10 published reference optima (no service needed)
npm run test:samples    # live service vs. the 10 public cases (service must be running)
npm run test:llm        # real Gemini calls: 10 public cases + 8 paraphrase probes
npm run test:cov        # coverage report
```

`npm test` is deterministic and offline: the model is replaced by a stub that replays
the published ground truth, so every other layer is still exercised. `test:llm` is the
only suite that spends API quota, and it spaces requests (`--gap=7000` by default) to
stay inside the free tier's per-minute limit.

---

## 11. HTTP status codes

| Code | When |
|---|---|
| 200 | Successful health or optimization response |
| 400 | Malformed JSON, or a structurally invalid request body (validation detail included) |
| 422 | Well-formed but semantically invalid — duplicate/missing hours, or no feasible schedule |
| 500 | Controlled internal error: `{"error": "Internal server error"}` |

No response ever contains a stack trace, a provider message, or a credential. Provider
errors logged server-side are scrubbed of anything key-shaped before they are written.

---

## 12. Known limitations

- **Free-tier quota is the main operational risk.** `gemini-2.5-flash` on the free tier
  has per-minute and per-day request caps; a judging run that exceeds them pushes
  requests onto the deterministic failure path, which is correct on the public set but
  is not the language model. For a scored run, use a billed key or supply several keys
  via `GEMINI_API_KEYS`.
- **Model availability shifts.** Models are retired from the free tier over time; if
  `GEMINI_MODEL` or a fallback returns 404, set it to a currently available model.
- Per-note interpretation only: a single note that expresses two directives yields one
  entry, matching the contract that each note maps to exactly one directive type.
- No battery round-trip efficiency, degradation cost, or grid export — none are part of
  the challenge model.
- The in-process interpretation cache is per-instance and is lost on restart; running
  several replicas means each warms its own cache.
- Ties between equally cheap schedules are broken by the cycling penalty, so a returned
  plan may differ from the reference plan while matching its cost.

---

## 13. Dependencies

| Package | Role |
|---|---|
| `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express` | HTTP framework |
| `@nestjs/config` | Environment configuration |
| `@google/genai` | Google Gemini SDK — operator-note interpretation |
| `javascript-lp-solver` | Linear-programming solver |
| `class-validator`, `class-transformer` | Request schema validation |
| `reflect-metadata`, `rxjs` | NestJS runtime requirements |
| `jest`, `ts-jest`, `supertest`, `@nestjs/testing` | Test tooling (dev only) |
| `@nestjs/cli`, `typescript`, `ts-node`, `@types/*` | Build tooling (dev only) |

Problem statement, participant guide and the public sample case pack are © BUP CSE Fest
2026 organizers. The sample pack is vendored at
`sample-cases/public-sample-cases.json` so the test commands run without extra setup.

---

## 14. Secrets

No API keys, tokens, `.env` files, or other credentials are committed to this
repository. `.gitignore` excludes `.env` and `.env.*` (except `.env.example`);
`.dockerignore` keeps them out of the build context; the Docker image carries no
credentials and requires `GEMINI_API_KEY` at runtime. API responses and logs are
scrubbed of key-shaped values and never include stack traces.
