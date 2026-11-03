// The task Go starts a planner with. No Herdr imports, so `node --test` can load this file.
// A mod can't import from outside its folder, so `mods/linear/task.js` is a copy of this file.
//
// Anyone who can edit a ticket can write into it, so a start command carries the session id and nothing else: no
// title, description or url. The planner reads tickets through Linear, and the ticket-session skill says that's data.
const SESSION = /^[\w-]+$/;

// On Windows a session's brief lists legwork projects in the tickets' place, and the task says so in fixed words.
const LEGWORK = " Its brief lists legwork projects, not Linear tickets: each id is a project's file in the legwork tracker, so plan from the project and its next prompt, and read nothing from Linear.";

// Null for anything that isn't a session id. `source` is "legwork" for a brief of legwork projects.
export const taskFor = (session, source) => (SESSION.test(session ?? "")
  ? `Follow the ticket-session skill for session ${session}.${source === "legwork" ? LEGWORK : ""}` : null);
