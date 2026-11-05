# Ticket routing

**Situation.** Support tickets land in one inbox and someone reads each one to pick its queue. A classifier reads
the subject and body and answers with the queue, so tickets reach the right team at once.

**Data needed.** Past tickets with the queue they ended up in: a subject, a body and a queue column. A few hundred
rows per queue is plenty; 50 per queue is enough to start. `tickets.csv` is a synthetic sample of 240 tickets across
five queues (billing, technical, account, shipping, returns).

**Steps.**

1. Models › Add model › Start from a recipe › Ticket routing. The sample loads as a dataset and the queues become
   the label set.
2. Version 0 answers at once: try it in the Playground, then read its scores on Evaluations.
3. Train a version on Training. It goes live only when label accuracy is at least 85% and it is at least as good as
   the live version.
4. Point the mapping at your own tickets (Data › dataset) and train again.

**When it is not a fit.** Routing that depends on the customer's account or history, not the ticket text, belongs in
the ticketing system's rules. Queues that change every week need retraining that often; a prompt-only version with
the label list may be enough. Predicting resolution time or volume is regression on tables: use classic ML.
