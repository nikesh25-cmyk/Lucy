# Research failure recovery

Failed browser-managed research runs now retain a bounded report in the existing private job history: task identifier, execution stage, affected source number when available, whether claim release was confirmed and whether the operator requested stopping. There is no new database migration. Existing plain-text job records remain readable.

The worker tracks permission checks, task selection, claiming, source retrieval, local synthesis, submission and run recording. A failed source identifies its position in the supplied URL list; the report does not retain the URL, response body, credential or raw error text. All source reads must finish before evidence is submitted. A failure releases its claim where possible. Failed release is explicitly unconfirmed; the operator must inspect active claims and wait for lease expiry or resolve the claim before retrying. A submission-stage interruption may have reached the server, so inspect contribution history first. No automatic retry can imply that a submission was absent.

My contributions shows the stage, task, practical repair guidance, cleanup status and a route back to mission tasks. Operations shows readable report summaries. Runtime credentials are still revoked by the managed runner’s cleanup. The report is an execution observation; it does not prove source quality, factual support or readiness to proceed.

Verification includes an isolated source failure after one successful source, no partial submission, successful release, failed release remaining unconfirmed, private history, module serving and credential revocation. Actual browser QA started an intentionally failing fictional agricultural-source task, displayed Source 1 and confirmed claim release, then followed Open mission tasks and inspected the open task again. No production account or external recommendation was created.


Source-stage history now carries bounded access-check, access-denied, rate-limit and unreadable-content classifications while preserving legacy records. See `SOURCE_ACCESS.md` for response recognition, live verification and privacy limits.
