# What ChatGPT and Claude do, and what Forge AI should take from them

## How reliable this is

Researched 10 November 2026 by web search. **Most of what follows comes from
third-party blogs, wikis and vendor pages, and several of them contradict each
other.** One source claimed Claude's desktop app "runs models locally", which is
false and tells you the general standard of the material. Anthropic's and
OpenAI's own help centres are the only authoritative sources, and the specific
claims below should be checked against them before anyone builds to a deadline.

Treat the feature *categories* as reliable — they are corroborated across
sources — and treat dates, plan tiers and product names as unverified.

## What they have that Forge AI does not

Ordered by what a Forge AI user would miss first, not by how interesting it is.

| # | Feature | Them | Forge AI today | Size |
| --- | --- | --- | --- | --- |
| 1 | Regenerate an answer | Both, long-standing | **Built, this round** | — |
| 2 | Find an old chat | Both | **Built, this round** (title and body) | — |
| 3 | Edit a question and re-ask | Both | Missing | Small |
| 4 | Export a conversation | Both | Missing | Small |
| 5 | Projects: files and instructions shared across chats | Both | Missing. Forge has single conversations only | Medium |
| 6 | Artifacts: documents, charts, slides in a side panel | Claude | Partial: HTML preview and interactive blocks exist; no documents, charts or slides | Medium |
| 7 | Voice | Both | Missing | Medium |
| 8 | Keyboard-driven quick entry from anywhere | Both | Missing | Small |
| 9 | MCP / connectors to outside tools | Both | Partial: a connector and skill system exists; no MCP | Large |
| 10 | Agentic work: using a computer or browser on your behalf | Both | **Built, in the smaller form**: named workers, one task at a time, with web search, page reading, files, reminders and memory. No mail, no parallel runs, no computer control. | Large |

## What Forge AI has that they do not

Worth protecting rather than trading away while copying features.

- Inference on the person's own machine, with no account and no network call.
- Any GGUF model on Hugging Face, with its real size and whether it fits.
- Measured timings under every answer, none of them estimated.
- Memory that is only written when a person agrees to it.
- A browser whose every action is recorded on the turn it produced.

## Recommended order

**Now (small, and each one is a thing people reach for daily):** edit and re-ask,
export a conversation, keyboard quick entry.

**Next: Projects.** This is the single biggest structural gap. Both products use
it as the unit of work; Forge AI has no way to keep files and instructions across
chats. It also makes the memory and attachment features already in Forge AI much
more useful, so it compounds.

**Then: Artifacts, properly.** Forge AI renders HTML and interactive blocks
already. Extending that to documents and charts is a smaller step than it looks,
and it is the feature people quote when they say Claude feels capable.

**Deliberately last: agent mode and computer use.** Both are the headline
features and both are the wrong thing for Forge AI to rush. An agent that drives
a computer is the single largest security surface a desktop app can take on, and
Forge AI's entire argument is that nothing leaves the machine and nothing happens
without the person asking. Doing this badly would cost more than shipping it late.

**Not recommended: voice**, until the above are done. It is expensive to do well,
and nobody chooses a local-model app for its voice.

## What "Forge AI models that do all of it" means in practice

Forge AI does not train models; it runs open-weight ones. So "a model that can do
everything" is really a routing question, and most of it already exists: the
catalogue, auto-selection by declared strengths and free memory, and vision via a
projector file. What is missing is narrower and worth doing:

- **Task presets** — a named set of model, context size and run mode per kind of
  work (long document, code, quick question), instead of one global setting.
- **Honest capability labels.** Several cards read `unmeasured`. A short local
  benchmark on first run would replace guesses with figures, which is what the
  rest of the app already promises.
- **A fallback chain** so a request that does not fit the chosen model moves to
  one that does, and says that it did.

## Sources

Third-party unless marked. Listed so the claims above can be checked.

- OpenAI: [ChatGPT release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes) (authoritative), [ChatGPT Business release notes](https://help.openai.com/en/articles/11391654-chatgpt-business-release-notes) (authoritative), [ChatGPT for your most ambitious work](https://openai.com/index/chatgpt-for-your-most-ambitious-work/) (authoritative)
- [ChatGPT](https://en.wikipedia.org/wiki/ChatGPT), [ChatGPT Atlas](https://en.wikipedia.org/wiki/ChatGPT_Atlas), [OpenAI Codex](https://en.wikipedia.org/wiki/OpenAI_Codex_(AI_agent))
- [GPT-5.6 and the new ChatGPT desktop app](https://www.theneuron.ai/explainer-articles/gpt-5-6-and-the-new-chatgpt-desktop-app-complete-guide/), [ChatGPT desktop fact sheet](https://www.getjarvis.eu/research/chatgpt-desktop-facts) (competing vendor), [TechSpot download page](https://www.techspot.com/downloads/7619-chatgpt-desktop-app.html)
- [Claude features 2026](https://suprmind.ai/hub/claude/features/), [Claude Desktop guide 2026](https://precisionaiacademy.com/blog/claude-desktop-guide-2026), [Claude Desktop in 2026](https://claudelab.net/en/articles/claude-ai/claude-desktop-app-complete-guide-2026), [Claude features explained](https://softwired.com.au/post/claude-features-explained), [Claude Desktop](https://kevinwelter.com/en/blog/claude-desktop), [Claude Desktop wiki](https://ai.miraheze.org/wiki/Claude_Desktop), [What it does](https://www.lowcode.agency/blog/what-is-claude-desktop), [Desktop vs browser](https://www.barside.space/content/claude-desktop-app-vs-browser), [Install guide](https://www.ai-toolbox.co/claude-management-and-productivity/how-to-install-claude-desktop-computer-use-2026)
