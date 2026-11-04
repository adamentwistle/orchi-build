// The task Go starts a planner with. No Herdr imports, so `node --test` can load this file.
// A mod can't import from outside its folder, so `mods/tickets/task.js` is a copy of this file.
//
// Anyone who can edit a ticket can write into it, so a start command carries the session id and nothing else: no
// title, description or url. The planner reads tickets with orchi tickets, and the ticket-session skill says that's data.
const SESSION = /^[\w-]+$/;

// Null for anything that isn't a session id.
export const taskFor = (session) => (SESSION.test(session ?? "") ? `Follow the ticket-session skill for session ${session}.` : null);
