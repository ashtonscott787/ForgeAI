# Agents

An agent is a saved worker, not a separate AI: a name, a job, the rules it
follows, the model it runs on, and an explicit list of what it may do. It is a
configuration wrapped around a model already downloaded on this machine.

## What you set up

A name and a role ("Bea, handles supplier email"), standing instructions in
plain words, the model it runs on (or Auto), and its permissions. Nothing is
implied: a tool left unticked cannot be called.

## The loop

You give it a goal rather than a prompt. It writes a short plan, then carries
out one step at a time, and each result is fed back so the model sees what
actually happened rather than what it hoped would happen. You can stop it at any
point.

Reading runs freely. Anything that changes something outside the conversation
stops and waits for your yes, unless you have pre-approved that exact tool for
that agent.

## Where the permission check lives

In the main process, in `agent_act`, not in the page and not in the model. Every
call is re-checked against what that agent was granted. A model can be talked
into asking for anything; it cannot talk the check into allowing it. An
`approved: true` flag is only honoured for a call that this same check says
needs approval.

Three refusals worth knowing:

- A tool the agent was not granted is refused, and the message says where to
  grant it.
- A tool that does not exist is refused by name. Anything unrecognised is
  treated as world-changing rather than trusted.
- Pre-approval for a tool the agent does not have is dropped when the agent is
  saved, so granting that tool later does not silently arrive pre-approved.

## Tools

| Tool | Changes anything? |
| --- | --- |
| Search the web | No |
| Read a web page | No. Local addresses are refused, so an agent cannot be pointed at this machine's own network |
| Read files in a folder you choose | No. You pick the files each time |
| Use your knowledge packs | No |
| Write or change a file | Yes. You choose the file in a save dialog |
| Create a reminder | Yes |
| Save something to memory | Yes |

Mail and calendar are absent, not stubbed. An agent cannot be given a permission
for something the app cannot do, so the "Bea answers supplier email" idea needs
the IMAP work first.

## The hardware problem, stated plainly

Agent loops are hard for small models. Deciding what to do, calling a tool
correctly and recovering from a failure needs a 7B-class instruction model. A
1.5B model will do the wrong thing confidently.

A 7B at Q4 is roughly 4.5 GB of weights before any context, so a machine with
about 5 GB usable is not "tight" — it is too small. The Agents page measures
this machine and says so rather than letting someone discover it slowly.

## Sharing

Export writes one JSON file; import validates every field, drops anything
unrecognised and assigns a new id, so importing the same agent twice does not
overwrite the first. An imported file cannot smuggle in a permission that does
not exist: unknown tool names are stripped.
