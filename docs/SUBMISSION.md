# Getting listed — the connector connector

The founder's line: *"I can't be a back door connector. I'll have to be a
connector connector."* That's the right instinct. Pasting a URL into a settings
box works today, but it means every user has to be told the URL by you. Being
**listed** means they find you.

This is what that actually takes, what's ready, and what isn't.

---

## The hard prerequisite

**Nothing can be submitted anywhere until the server is deployed and answering.**
Every directory tests the live endpoint as the first step of review — they call
`initialize`, walk the OAuth flow, and list the tools. A repo and a domain are
not enough.

So the order is fixed:

1. Push the repo → 2. Run the three SQL files in Supabase → 3. Deploy to Netlify
with the env vars → 4. Point `wrought.fit` at it → 5. Connect it manually and
use it for a week → 6. *Then* submit.

Step 5 is not optional padding. Reviewers notice a server with no real usage,
and you will find three things wrong in the first week that you'd rather find
before a reviewer does.

---

## Ready now

Everything a directory asks for that is code or copy is done:

| Requirement | Status |
|---|---|
| MCP over Streamable HTTP, protocol `2025-06-18` | ✅ `netlify/functions/mcp.js` |
| OAuth 2.1 + PKCE + dynamic client registration | ✅ RFC 7591, no manual client setup |
| `.well-known/oauth-authorization-server` | ✅ served with correct Content-Type |
| `.well-known/oauth-protected-resource` | ✅ |
| Tool annotations (`readOnlyHint`, `destructiveHint`, …) | ✅ every tool |
| Tool descriptions a model can act on | ✅ all 25 |
| Privacy policy | ✅ `/privacy.html` — names every subprocessor |
| Terms of service | ✅ `/terms.html` |
| Agent-readable overview | ✅ `/llms.txt` |
| Connector manifest | ✅ `/.well-known/mcp.json` |
| Data export | ✅ `/api/export` |
| Data deletion path | ✅ documented, email |
| Support contact | ✅ |
| Public source | ✅ |
| Medical disclaimer | ✅ on every surface |

### Still to do before submitting

- [ ] **Deploy.** Everything below depends on it.
- [ ] **An icon.** Directories want a square PNG, usually 512×512 and 1024×1024.
      The wordmark on iron — no symbol, per the brand doctrine.
- [ ] **Rate limiting.** Reviewers check that a connector can't be hammered.
      Per-token counting in Supabase with a short window is enough.
- [ ] **A demo account** with a few weeks of realistic data. Reviewers need to
      see tools return something, and an empty account reviews badly.
- [ ] **Two or three screenshots** — the connect flow, a live session, the
      dashboard.

---

## Per directory

### ChatGPT

**Works today, unlisted:** Settings → Connectors → Add custom connector → paste
`https://wrought.fit/mcp`. That's the back door, and it's genuinely fine for
early users.

**To get listed:** OpenAI's app directory is submission-and-review. It's built on
MCP, so the server itself needs no changes — what they assess is the metadata,
the policies, the OAuth flow and whether the tools do what they claim. Health
apps get extra scrutiny; the medical disclaimer and the "not a medical device"
framing being *already* in the tool descriptions and server instructions helps
here rather than being bolted on for review.

### Claude

**Works today, unlisted:** Settings → Connectors → Add custom connector. Claude
registers itself via dynamic client registration and opens the sign-in — nothing
to configure.

**To get listed:** Anthropic's connector directory, also submission-and-review.
Same requirements. Dynamic client registration already working is a real
advantage — a connector that needs manual client provisioning is a harder sell.

### Everyone else

Most of these take MCP servers with no gatekeeping at all, and they're worth
doing first precisely because they're free and instant:

- **Cursor, Windsurf, Zed, Goose, LibreChat, Continue** — community MCP lists,
  usually a pull request against a registry repo.
- **Gemini / Google** — extensions, moving toward MCP.
- **Copilot** — MCP support in agent mode.
- **Public MCP registries** — several exist and are just a PR.

**Do these first.** They cost an afternoon, they're reversible, and every one of
them is a real listing before the big two have finished reviewing anything.

---

## Two honest warnings

**A solo operator with no company entity is friction.** Not a blocker, but some
directories ask for a business entity, a verified domain, or a named data
controller. Consider whether an incorporated entity is worth having before
submitting to the big two — it also makes the privacy policy's "who is the
controller" question cleaner.

**Health data invites the hardest review you'll get.** That's correct and worth
welcoming rather than dreading: this product is already built to that bar. The
care flags, the labelled estimates, the refusal to invent a working weight and
the refusal to diagnose are not decoration — they are precisely what a reviewer
looking at a health connector wants to find. Point at them.

---

## The order I'd actually do it in

1. **Deploy**, then use it yourself for a fortnight. Fix what breaks.
2. **Community registries** — free listings, immediate, no review.
3. **Icon and screenshots.**
4. **Rate limiting.**
5. **Claude directory**, then **ChatGPT**. Bring the week of real usage with you.

Being pasted into a settings box is not a failure state — it's how every
connector starts, and it's how you find the bugs that would have sunk a review.
