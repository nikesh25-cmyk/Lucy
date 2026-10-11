# Research worker

Use the Research desk to activate a proposed brief. Select your own character, open **Run my research agent**, and provide one to five approved public HTTPS HTML pages. The worker records a job and returns immediately. Find its pending output in **My contributions**; an independent reviewer must accept it. **Stop my worker** aborts the run. On cancellation, the worker attempts a separate five-second request to release its own active lease. If revocation or an unavailable world prevents cleanup, release it from Contributions or wait for expiry.

The worker uses a four-minute, twenty-call credential limited to `read` and `contribute`. It reads at most five sources, one megabyte each for HTML, with a fifteen-second HTML source deadline and three-minute overall deadline. It refuses redirects, local/private network destinations and unreadable files. DNS validation is followed by address-pinned HTTPS. Source pages are treated as data. No source content is executed. The exact catalog-reviewed Tea Board Directive 02/2026 PDF is also supported (10,208,913 bytes; ninety-second source deadline), after fresh SHA256 verification against its visual review. Other PDFs require visual review.

Default output is an attributed evidence register with source checksum, retrieval time and a maximum 24-word opening excerpt per source. This establishes accessibility, not factual correctness. If `LUCY_MODEL_NAME` names a configured local Ollama or llama.cpp model, the worker also generates a provisional source-grounded draft. No cloud billing or provider credentials are required.

For CLI operation, set `WORLD_AGENT_TOKEN`, `WORLD_URL`, `WORLD_TASK_ID`, and `WORLD_SOURCE_URLS` (JSON URL array) in a private environment, then run `npm run research`. Do not commit credentials. The account's selected agent must own the scoped runtime session. Tasks permit exact approved hostnames; add legitimate country agency hosts when activating the proposal.

Runs have no outbound contact or government-submission capability. Accepted output and documented adoption are separate stages. After a server restart, in-progress job records are marked stopped; inspect an existing claim before retrying. Never silently repeat a submission.

Local Ollama setup: https://docs.ollama.com/quickstart and https://ollama.com/download/mac . Choose a model appropriate for the available RAM, install it separately, and restart Lucy with `LUCY_MODEL_NAME`. No model-quality or full autonomy claim follows from successful generation.

Apple Silicon Macs can use the pinned [project-local AI installer](LOCAL_AI.md). The launcher starts a verified installed model automatically; an incomplete download leaves inference disabled.

Source extraction prefers semantic main/article content, main roles or declared body-content regions and removes navigation, headers, sidebars, scripts and forms. It decodes common/numeric entities and records the extraction location. A source-declared publication date is recorded separately when supplied in recognized HTML metadata; it is not independently verified. Absence remains unknown. Extraction is heuristic and does not establish legal currency or substantive correctness.

The server shares one inference request at a time across mayor dialogue and research synthesis. At most eight requests can wait. Cancelled or expired queued requests are removed without model dispatch; excess work fails visibly. Mayor failures return scripted guidance and worker failures retain the existing release/review rules. This bounds shared local compute; it is not a throughput benchmark.

Queued research synthesis rechecks runtime scopes, pause state and remaining submission budget immediately before model dispatch. Mayor work rechecks the session, world pause and resident status at that same point. Revoked work is not dispatched.

The server permits four active research workers in total, with one per human operator. At capacity it returns a visible refusal before creating another credential or job. This bounds simultaneous source-read memory and network work; the proposal backlog can be processed over successive runs. Health reports active workers and the limit.

The reviewed PDF path uses dated, page-located paraphrases from the retained visual review. It executes no PDF content, does not automatically interpret a changed edition, and does not establish current shipment applicability or later amendments. Successful hash verification identifies the reviewed edition. Independent acceptance and legal applicability still require human review.

Operators can inspect their own latest 100 job records in **My contributions**, refresh status and contributions, and request research cancellation there. Reviewer access does not disclose another operator's run summaries. Runtime history is additionally restricted to its own agent. Main-process startup marks interrupted running jobs stopped and audits each recovery once; existing submissions are never automatically repeated.

Model synthesis uses structured findings with validated source-number arrays and explicit evidence gaps. Each finding receives formatted inline citations; total draft length remains bounded. Citation validity does not establish factual support. Invalid model output fails the run, and its claim follows the same release and recovery path.
