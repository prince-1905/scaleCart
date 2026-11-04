# Interview notes — Phase 4.6: A Redis "door counter" for the hot stock row

Evidence: [E6 experiment report](../experiments/E6-redis-stock-gate.md). Background: [Phase 4.5 notes](phase-4.5-drops.md).

---

## 1. The 30-second version

> "In a drop, every buyer updates **one stock row**. MySQL locks it per checkout until COMMIT, so one slow disk
> write freezes everyone behind it: the hot-row problem I measured in E5. I put a **Redis counter in front of it**: take
> 1 in Redis first (atomic Lua). At 0, the answer is 'sold out' without touching MySQL. Above 0, MySQL's conditional
> UPDATE still decides, so a wrong counter can only undersell, never oversell. With 1,000 buyers, 100 in stock and a
> deliberate 5-second row jam, the 900 losers got 'sold out' **10–30× faster** (p50 131–387 ms vs ~4 s), and in-flight
> requests dropped from 1,001 to 120–161. My first version **didn't help at all**: the counter sat after two MySQL writes."

---

## 2. Key concepts

| Term | Meaning | Analogy |
|---|---|---|
| **Hot row** | One database row that every request must lock | 1,000 customers and one pen to sign with |
| **Gate / admission filter** | A cheap check that stops requests before the expensive part | A guard with a clicker at the shop door |
| **Source of truth** | The system whose answer is final (here MySQL) | The shelf, not the clicker |
| **Fail open (here)** | Redis down → skip the gate, MySQL still decides | The guard leaves; the cashier still checks the shelf |
| **Reconcile** | Periodically reset the fast copy from the truth | Recounting the shelf every 10 s |
| **Seckill** | The well-known flash-sale design where Redis *is* the stock | No shelf check at all: faster, riskier |

---

## 3. The stories

### Story A — "I fixed the hot row… and measured that I hadn't" ⭐
- **First version:** 900 losers still got "sold out" in ~1.6–1.8 s, the same as without the gate.
- **Investigation:** I read the checkout order. Before the gate, each buyer read the cart and prices, then **inserted and
  committed** the "one purchase per customer" row, and deleted it again on "sold out". Two MySQL writes per loser; the
  gate only skipped the stock row.
- **Fix:** move the gate to the front: cart lines → rules (no DB) → gate → prices → purchase row → stock.
- **Result:** "sold out" p50 **131–387 ms vs 3,980–4,228 ms** during a 5 s jam; in-flight **120–161 vs 1,001**.
- **Lesson:** where a check sits in the pipeline matters as much as the check itself. Measure each step.

### Story B — "Why not let Redis be the stock (seckill)?" ⭐
- **Option A (built):** Redis filters who may *try*; MySQL decides. If Redis is wrong or down, we may sell fewer for
  ~10 s, never more.
- **Option B (seckill):** Redis *is* the stock and MySQL is updated later. Faster, and the winners would skip the row too.
  But if Redis loses its last second of writes (crash, failover), you can sell units you don't have, and you need
  reconciliation plus apologies.
- **Proof that A keeps correctness:** 12 runs with exactly 100 orders, and a test where the counter says 4 while MySQL
  says 0 still sells nothing.
- **Honest limit:** the **100 winners still wait for the jam** (~4.6 s), because they genuinely need the row. Fixing that
  means splitting the stock into several rows, or option B.

### Story C — "How does the counter stay correct?"
1. **Atomic take:** a Lua script checks and decrements in one step, so two buyers can't both take the last unit.
2. **Give back:** if checkout fails after the gate (sold out in MySQL, a price change, a crash in the transaction),
   the unit is `INCRBY`'d back.
3. **Reset every 10 s:** `SET counter = MySQL available` (only if the counter exists). This catches expired unpaid orders
   whose stock went back, admin changes, and lost give-backs. It's safe while buyers are checking out: it can only let a
   few extra buyers *try* MySQL, and MySQL refuses them.
4. **Fail open:** if Redis can't answer, checkout goes straight to MySQL, the way it worked before the gate.

---

## 4. Likely follow-up questions

**Q: Why is "sold out" still ~1 s without a stall?**
1,000 requests at once saturate one API CPU (auth, cart read, queue calls). The gate removed the database wait; the next
bottleneck is CPU, so add replicas (the gate lives in Redis, shared by all of them).

**Q: What if two API replicas reset the counter at the same time?**
Harmless: both set it to MySQL's number. Repeating a reset changes nothing.

**Q: How would you test that the gate really skips MySQL?**
Lock the stock row in another transaction, then check that a sold-out buyer still gets an answer quickly. My first test
only checked a metric, and a mutation (ignore the gate's answer) **didn't** fail it. The lock-based test does.

---

## 5. Self-quiz

1. What is the hot-row problem, in one sentence?
2. Why can the Redis counter never cause overselling?
3. Why did the first version not help?
4. What does the gate *not* fix, and what would?

<details><summary>Answers</summary>

1. Every buyer of the product must lock the same stock row until COMMIT, so one slow commit freezes all of them.
2. It only decides who may try. MySQL's `UPDATE … WHERE available >= n` still decides, so a wrong counter can only
   undersell, until the 10 s reset.
3. It sat after two MySQL writes (the purchase row INSERT and its DELETE), so losers still did database work and waited.
4. The winners still wait for the row (~4.6 s during a 5 s jam). Fix it by splitting the stock into buckets, or by making
   Redis the stock (seckill, with oversell risk).
</details>
