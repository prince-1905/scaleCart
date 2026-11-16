# Interview notes — Phase 6b: Two-factor login (authenticator app / TOTP)

Evidence: [E10 experiment report](../experiments/E10-two-factor.md). Code: `apps/api/src/identity/totp.ts`,
`two-factor.service.ts`, `apps/web/src/pages/Security.tsx`.

---

## 1. The 30-second version

> "I added two-step login with an authenticator app, the TOTP standard (RFC 6238), written on Node's crypto and checked
> against the RFC's test vectors. The password step returns a 5-minute challenge instead of tokens; the code step
> returns the tokens. Codes can't be replayed, the secret is encrypted at rest, and backup codes are keyed hashes. The
> important part is guessing: 6 digits is only a million values, so each guess first **reserves an attempt with one
> atomic MySQL UPDATE**. With 30 guesses at the same moment, exactly 5 are checked; the naive 'read then add' version
> checked all 30. Measured cost: the code step took 14–41 ms p50, and the server clock stayed within 0.2 s of real time
> against a 30 s tolerance."

---

## 2. As the user (know this flow by heart)

**Turning it on (once):**
1. Security → **Turn on** → the page shows a **QR code** (and the key as text).
2. Scan it with Google/Microsoft Authenticator. The app now shows a new 6-digit code **every 30 seconds**, even offline.
3. Type the current code → 2FA is **on**, and the page shows **10 backup codes once**. Save them.

**Every login after that:**
1. Email + password → not logged in yet. The server answers "code needed" (a 5-minute challenge).
2. Open the app → type the 6 digits → logged in.
3. Lost the phone? Type a backup code instead. Each one works once.

**Limits, as the user or an attacker:**
- A code works in its 30 s window ± one window, so **3 codes are valid at any moment**.
- **5 wrong codes → locked for 15 minutes**, even with the right code. Sending 30 guesses at once doesn't help: 5 are
  checked, 25 are refused.
- A code that already logged someone in **can't be used again**, even within its 30 s.

---

## 3. Key concepts

| Term | Meaning | Analogy |
|---|---|---|
| **2FA / MFA** | Login needs something you know (password) + something you have (phone) | House key + alarm code |
| **TOTP** | Code = HMAC(shared secret, current 30 s slot), 6 digits | Two identical watches running the same secret formula |
| **Shared secret** | 160 random bits, given to the phone once via the QR code | The formula both watches use |
| **Window ±1** | Accept the previous and next slot too, for clock drift | "A few seconds late is fine" |
| **Replay protection** | Remember the last slot used; refuse it and older ones | A ticket stamped "used" |
| **Challenge token** | Proof the password step passed; 5 min; can't be used as a login token | A wristband that only opens the second door |
| **Backup codes** | One-time codes for a lost phone, stored as keyed hashes | Spare keys, each works once |

---

## 4. The stories

### Story A — "30 guesses at once" ⭐ (race condition on a security counter)
- **Risk:** "check the counter, then check the code, then add 1". 30 requests arriving together all see `failed = 0`,
  so all 30 get checked.
- **Fix:** reserve first: `UPDATE user_totp SET failed_codes = failed_codes + 1 WHERE failed_codes < 5 AND not locked`.
  `affectedRows = 1` → you get one try; 0 → 429.
- **Proof:** 30 parallel wrong codes → **5 × 401, 25 × 429** (both runs). The naive version, as a mutation → **30 of 30**
  checked.
- **Same pattern as checkout:** the atomic conditional UPDATE that stops overselling (E1) also stops brute force.

### Story B — "Why the counter is in MySQL, not Redis" ⭐
- The rate limiter (E9) and the login throttle live in Redis and **fail open**: if Redis is down, requests go through.
- That's fine for "slow down a greedy client", but **not for a 6-digit secret**: an outage would mean unlimited guesses.
- So the 2FA counter and lock live in the same MySQL row as the secret: no extra system to fail.

### Story C — "My own frontend spent two attempts per wrong code" ⭐
- **Symptom:** a web test was logged out after one wrong code on the "turn on" screen.
- **Cause:** the shop's API client treats any 401 as "token expired": it refreshes and **re-sends** the request. A wrong
  code answered 401, so it was submitted twice: 2 of the 5 attempts used, tokens rotated.
- **Fix:** status codes mean something. A signed-in user's wrong code → **400** (bad input); login step 2 keeps **401**
  (not signed in yet).
- **Lesson:** an HTTP status is a contract with every client's retry logic.

### Story D — "Does the server clock matter?"
- TOTP compares the server's time slot with the phone's. This laptop's Docker clock is known to jump.
- **Measured:** API vs laptop over 3 min: −214 … +112 ms (run 1), −80 … +71 ms (run 2). The tolerance is ±30 s.
- In production, servers run NTP. Phones sync over the network. Window ±1 covers the rest.

---

## 5. Trade-offs I chose

| Choice | Why | Cost |
|---|---|---|
| TOTP app (not SMS/email) | Free, offline, can't be intercepted like SMS, industry standard | Users need an app; a lost phone needs backup codes |
| Written on node:crypto (no OTP library) | ~60 lines, testable with RFC vectors, no dependency | Must get the details right (base32, dynamic truncation) |
| Window ±1 | Clock drift between phone and server | 3 valid codes at a time instead of 1 |
| 5 tries, then 15 min lock | ~0.14%/day guessing odds for someone who has the password | An attacker can lock a real user out of the code step (they need the password first) |
| Secret encrypted (AES-256-GCM), key derived from JWT_SECRET unless TOTP_ENCRYPTION_KEY | A stolen DB dump alone doesn't give the secrets | Rotating the key needs a re-encrypt (not built) |
| Challenge = JWT with its own audience | No storage needed, refused as an access token | Valid for 5 min; can be reused within that (each use still needs a fresh code) |

---

## 6. Likely questions

1. **How does the app know the code without the internet?** Both sides have the secret and a clock. The code is a
   function of the two, so nothing is sent.
2. **Why accept 3 codes, not 1?** Clocks drift and people type slowly. ±1 step is the RFC's recommendation, and
   replay protection stops the same code being used twice.
3. **What if the database leaks?** The secrets are AES-GCM encrypted with a key that isn't in the database. Backup codes
   are HMACs with a server key, so they can't be brute-forced offline.
4. **What stops brute force?** 5 attempts per 15 min, reserved atomically in MySQL, plus the per-IP auth rate limit
   (E9) in front.
5. **Why not SMS?** SIM-swap attacks, cost, and delivery delays. NIST lists SMS as "restricted".
6. **What would you add next?** Revoke old sessions when 2FA is turned on, email alerts on enable/disable/lockout, make
   it mandatory for admins, passkeys (WebAuthn), and "remember this device".
7. **Isn't the challenge token a weakness?** It only proves the password step for one user, for 5 minutes, and only works
   at `/auth/login/2fa` (its own audience). Without a valid code it's useless.

---

## 7. Self-quiz

1. A user's phone clock is 40 seconds slow. Does their code work? What about 70 seconds?
2. Why does the attempt counter use `UPDATE … WHERE failed_codes < 5` instead of `SELECT` then `UPDATE`?
3. An attacker has the password and sends 1,000 code guesses in one second. How many are checked?
4. Why did a wrong code on the Security page cost two attempts at first?
5. Where is the TOTP secret stored, and in what form?
6. What does the server return after a correct password for a 2FA user, and why not tokens?

<details><summary>Answers</summary>

1. 40 s slow = one step behind, so it's accepted (window ±1). 70 s = more than 2 steps → refused.
2. SELECT-then-UPDATE lets parallel requests all read 0 and all get checked (30 of 30 in the mutation test). The
   conditional UPDATE is one atomic step, so only 5 slots exist.
3. 5. The rest get 429 (until the 15-minute lock ends). The per-IP auth rate limit also caps them earlier.
4. The API answered 401; the client treats 401 as an expired token, refreshes and re-sends. Now it's 400.
5. In `user_totp.secret_enc` (MySQL, identity DB): AES-256-GCM, nonce + ciphertext + tag. Never the plain base32.
6. `{ twoFactorRequired, challengeToken, expiresIn: 300 }`. Tokens would let a password-only attacker in, so the
   challenge only unlocks the code step.

</details>
