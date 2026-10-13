# Screen layouts and interaction flows — index

These files are the buildable detail behind [`docs/GAME_EXPERIENCE.md`](../GAME_EXPERIENCE.md). They
describe five surfaces for the game shell: the entry screen, two overlays, the world HUD, four panels
and one separate management mode.

**Status: specification of a target.** Nothing here is implemented by this task, which changes Markdown
only, and **no browser check was performed**. Wireframes are text, not screenshots. Every server field
cited is read from base commit `d59b691`.

| File | Surface | What it fixes |
|---|---|---|
| [entry-screen.md](entry-screen.md) | Entry screen | The three controls **Play · Observe · Continue**, their states and their defaults |
| [overlays.md](overlays.md) | Account and character overlays | Fields, validation, escape path, failure behaviour for both |
| [world-hud.md](world-hud.md) | World-first HUD | The five indicators and five actions, and the explicit not-on-HUD list |
| [panels.md](panels.md) | Chat · Journal · Inventory · Projects | Four dismissible drawers and the server field behind each |
| [management-interface.md](management-interface.md) | `/manage` | What moves behind it, the role gate, and the nav change |
| [flows.md](flows.md) | Interaction flows | Enter, move, interact, build — with the keyboard path for each step |

## Conventions used in every file

- **`app.js:NNN` / `game-theme.css:NN`** cite the base revision's source. They are the argument that an
  element is backed by real state, not an illustration.
- **"Today"** means the shipped source; **"target"** means what a build task would add.
- A wireframe box is a *region*, not a pixel layout. Existing class names (`game-hud`, `game-quickbar`,
  `world-aside`, `dialog`, `card`) are named where they are reused, so the implementation extends the
  shipped stylesheets instead of inventing a parallel shell.
- **Keyboard parity is a requirement, not a nicety.** Each flow file ends with the key path that
  completes it without a pointer, drawing on `src/camera-controls.js:21-47` and `app.js:1110,1493`.
- **No element may show a value the server did not return.** Where a value is remembered only in this
  browser it is labelled *client-only* and may never be presented as a server fact.
