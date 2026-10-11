# Research worker

Use the Research desk to activate a proposed brief. Select your own character, open **Run my research agent**, and provide one to five approved public HTTPS HTML pages. The worker records a job and returns immediately. Find its pending output in **My contributions**; an independent reviewer must accept it. **Stop my worker** aborts the run. A stopped lease can expire or be released from the contributions desk.

The worker uses a four-minute, twenty-call credential limited to `read` and `contribute`. It reads at most five sources, one megabyte each, with a fifteen-second source deadline and three-minute overall deadline. It refuses redirects, local/private network destinations and unreadable files. DNS validation is followed by address-pinned HTTPS. Source pages are treated as data. No source content is executed. PDF research requires manual visual review.

Default output is an attributed evidence register with source checksum, retrieval time and a maximum 24-word opening excerpt per source. This establishes accessibility, not factual correctness. If `LUCY_MODEL_NAME` names an installed local Ollama model, the worker also generates a provisional source-grounded draft. No cloud billing or provider credentials are required.

For CLI operation, set `WORLD_AGENT_TOKEN`, `WORLD_URL`, `WORLD_TASK_ID`, and `WORLD_SOURCE_URLS` (JSON URL array) in a private environment, then run `npm run research`. Do not commit credentials. The account's selected agent must own the scoped runtime session. Tasks permit exact approved hostnames; add legitimate country agency hosts when activating the proposal.

Runs have no outbound contact or government-submission capability. Accepted output and documented adoption are separate stages. After a server restart, in-progress job records are marked stopped; inspect an existing claim before retrying. Never silently repeat a submission.

Local Ollama setup: https://docs.ollama.com/quickstart and https://ollama.com/download/mac . Choose a model appropriate for the available RAM, install it separately, and restart Lucy with `LUCY_MODEL_NAME`. No model-quality or full autonomy claim follows from successful generation.
