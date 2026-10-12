# Collector cancellation

The trade collector records whether each query was dispatched to the secured reader. This does not prove provider receipt. Cancelling during a pacing wait leaves that query unrequested.

SIGINT and SIGTERM during collection stop queued work and write the candidate report, CSV and retained original responses. The CLI then exits 130 or 143 respectively. Per-source timeouts remain distinct from collection stops. Unexpected reader exceptions produce bounded unavailable diagnostics without copying thrown content.

Verification: a real CLI SIGINT run exited 130, retained zero observations and saved ten collection-stop gaps; the candidate passed validation. One query was dispatched and nine remained unrequested. No observations, trend or zero trade were inferred. Unit coverage also checks paced cancellation and a non-Error reader exception.

Existing limits remain: at most ten queries, two concurrent reads, five-second dispatch spacing, fifteen seconds per read and a three-minute collection deadline. A candidate still requires human review and explicit submission.
