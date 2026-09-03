# A custom ChatGPT for WROUGHT

The pasted-in connector (`https://wrought.fit/mcp`) works, and it has one
structural weakness: ChatGPT does not reliably show the MCP instruction sheet
to its model. That is the cause of most of the failures in the memory file —
saves claimed without a call, the conversation treated as the record, a
calorie figure invented. A custom GPT fixes it at the root: its own
Instructions box is read every turn, and its Actions reach the same server
over plain HTTP.

Nothing is reimplemented. Every Action is the MCP tool of the same name.

## Ten minutes, once

1. **Run the migration.** `schema/028_wrought_oauth_secret.sql` in Supabase
   (or through the connector, with no session active). It adds the one column
   a confidential client needs.

2. **Create the GPT.** ChatGPT → Explore GPTs → Create → Configure. Name it
   *WROUGHT* (or *Gym Bro*). Leave the Instructions box for step 5.

3. **Add the Action.** Configure → Create new action → Import from URL:

   ```
   https://wrought.fit/actions/openapi.json
   ```

   Authentication → **OAuth**. Leave client id and secret blank for a moment;
   save the action once so ChatGPT shows you its **callback URL** — it looks
   like `https://chat.openai.com/aip/g-XXXXXXXX/oauth/callback`. Copy it.

4. **Register the client** with that callback, from any terminal:

   ```
   curl -s -X POST https://wrought.fit/oauth/register \
     -H 'Content-Type: application/json' \
     -d '{"client_name":"WROUGHT GPT","token_endpoint_auth_method":"client_secret_post",
          "redirect_uris":["https://chat.openai.com/aip/g-XXXXXXXX/oauth/callback"]}'
   ```

   The reply carries `client_id` and `client_secret`. **The secret is shown
   once** — it is stored hashed. Back in the action's OAuth settings:

   | field | value |
   |---|---|
   | Client ID | the `client_id` from the reply |
   | Client Secret | the `client_secret` from the reply |
   | Authorization URL | `https://wrought.fit/authorize.html` |
   | Token URL | `https://wrought.fit/oauth/token` |
   | Scope | `wrought` |
   | Token Exchange Method | Default (POST request) |

   Save. If ChatGPT shows a different callback URL after saving, register
   again with the new one (it changes when the GPT is first published).

5. **Paste the instructions.** Open

   ```
   https://wrought.fit/actions/instructions
   ```

   and paste the text into the GPT's Instructions box. It is the MCP sheet
   condensed to under 8,000 characters — the cap ChatGPT enforces — and it is
   served from the live server so it never goes stale.

6. **Conversation starters** (optional): *hit me* · *what's the damage* ·
   *I'm going to the gym* · *check my log*.

7. **Test it**: "what account am I on" should sign you in with WROUGHT and
   answer with your email from `get_profile`. Then "had two eggs and toast"
   should come back with the calories, the time it was logged at, and the
   day's total — all from the reply, none from the model.

## What is and is not different

- **Same record, same account.** The GPT signs in to the same account as
  the connector and the website; there is nothing to merge.
- **Thirty operations.** ChatGPT allows thirty per Action, so the daily tools
  have an operation each and everything else goes through `call_tool` with
  the tool's name. The GPT knows which is which from the document.
- **Photos still work the same way.** The GPT reads the plate and passes the
  macros in `log`; the server never sees the image.
- **The connector stays.** Claude reads the MCP sheet properly and needs
  none of this. A GPT is for ChatGPT, where the sheet was the weak link.
- **Notifications are unrelated.** They come from the installed website,
  not from any GPT or connector.
