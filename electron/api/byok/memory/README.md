# BYOK Conversation Memory

File-backed conversation memory for stateless BYOK (direct API) providers.

Session-based providers maintain conversation context through browser tabs.
BYOK calls are stateless, so this store persists message history per
conversation to enable multi-turn conversations. History is condensed and
pruned by the smart context pipeline (see `../context`).

**Status:** Implemented — see `index.cjs` (`load` / `save` / `clear` / `clearProvider`).
