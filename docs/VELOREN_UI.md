# NemoWorld Harr UI Architecture & Reference (`VELOREN_UI.md`)

This document describes the design, implementation, and contracts for stream `ui`: making Harr visible, peaceful, accessible, and futuristic across both the in-game client (`voxygen`) and the companion web dashboard.

---

## 1. Executive Summary

Stream `ui` fulfills the owner's directive:
> *"we are not promoting a game with swords and attacks and dungeons. We are building a world with scholars, research, cooperation, growth, discovery and abundance."*
> *"a way to see all the details: works, tasks, our greater purpose, and how to research and innovate reflected in the game."*

The stream consists of three interconnected deliverables:
1. **U1. In-game Harr HUD Panel (`voxygen/src/hud/harr.rs`)**: An integrated, calm Conrod panel toggled with key `H` displaying live village data without blocking rendering.
2. **U2. Peaceful Client Localization & Character Creator (`voxygen/src/menu/char_selection/ui.rs`, `assets/voxygen/i18n/en/*.ftl`)**: Transform weapon selection into musical instruments (Lute, Flute, Lyre, Kalimba, Oud) and reword all user-facing UI away from combat into discovery, craft, and care.
3. **U3. Harr Companion Dashboard v2 (`harr.html`, `harr.js`, `harr.css`)**: A responsive (<45 KB, zero external assets, strict CSP), mobile-first accessible web application featuring an interactive SVG coordinate map of Harr, circular goal progress rings, an SVG research dependency tree, and a "What can I do now" active prompt panel.

---

## 2. In-Game Harr Panel (`voxygen/src/hud/harr.rs`)

### 2.1 Interaction & Ergonomics
- **Default Keybinding**: `H` (bound via `GameInput::Harr`, configurable in Controls settings).
- **Controller Support**: Mapped to Secondary Navigation action.
- **Escape Integration**: Dismisses cleanly with `Esc` alongside standard Veloren HUD windows.
- **Cursor Grab**: Safely releases cursor grab when open (`want_grab = !self.any_window_requires_cursor()`).

### 2.2 Asynchronous Background Poller
To prevent any network lag from stuttering the 60+ FPS client render loop:
- A dedicated background thread executes HTTP requests with short socket timeouts (1.0 second).
- Thread polls every 5.0 seconds.
- Auto-probes loopback ports:
  - Port `3100`: Primary live production stack.
  - Port `3218`: Stream `ui` test stack (`3200 + 18`).
- Reads `GET /api/v1/veloren/harr/overview` and `GET /api/v1/veloren/harr/tasks`.
- Thread-safe state sharing via `Arc<Mutex<HarrState>>`.
- **Fault-Tolerant State**: When NemoWorld is booting, restarting, or unreachable, the HUD gracefully displays:
  > *"The village is quiet. Connecting to Harr records..."*

### 2.3 Six Informational Tabs
1. **Tasks**: Personal active tasks with explicit next steps, objective descriptions, and completion tallies.
2. **Purpose**: The Harr Charter, founding virtues, and circular progress indicators toward village-wide goals.
3. **Works**: Public works staged construction projects, listing active stage, progress bar, required materials, and "Needs a crew" status tags.
4. **Research**: Civic research queue categorized into *Currently Researching*, *Learned Technologies*, and *Queued Innovations*.
5. **Library**: Natural history discoveries and field notes, revealing hints for unfound coordinates.
6. **Community**: Village rhythm phase, active villager roster, pantry meals available, and restocking schedule.

---

## 3. Peaceful Client Localization (U2)

### 3.1 Musical Instrument Selection
Veloren's character creation originally forced players to choose a weapon (sword, axe, hammer, bow, staff). In Harr:
- Header updated: **"Choose your instrument"**
- Instrument Choices:
  - **Lute**: Plucked melodic resonance (`STARTER_SWORD` mapping)
  - **Flute**: Breath of the winds (`STARTER_BOW` mapping)
  - **Lyre**: Classical harmonic strings (`STARTER_STAFF` mapping)
  - **Kalimba**: Gentle thumb resonance (`STARTER_HAMMER` mapping)
  - **Oud**: Deep, earthy acoustic tones (`STARTER_AXE` mapping)
- Server compatibility: The server character creator receives the legacy weapon IDs and gives the player an instrument without combat capability, maintaining strict peaceful contract without breaking server schemas.

### 3.2 String Transformation Catalog (`STRINGS.md`)
Over 100 client strings were reworded across 9 Fluent (`.ftl`) translation bundles:
- `char_selection.ftl`: Weapons -> Instruments; Combat attributes -> Creative talents.
- `main.ftl`: Combat tips -> Cooperation, library study, and community advice.
- `tutorial.ftl`: Attacking/slaying monsters -> Crafting, observing wildlife, building village structures.
- `hud/map.ftl`: Dungeons, bosses, and monster dens -> Observatories, research sites, and archaeological ruins.
- `hud/settings.ftl`: Attack keys -> Instrument play / Tool interaction.
- `hud/bag.ftl` & `hud/crafting.ftl`: Armor/weapons -> Attire, work aprons, study tools, and botanical specimens.

---

## 4. Harr Companion Dashboard v2 (U3)

### 4.1 Strict Constraints & Performance
- **Zero External Dependencies**: Pure vanilla HTML5, CSS3, and JavaScript. No external fonts, CDNs, or frameworks.
- **Strict CSP**: `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:;`
- **Total Asset Size**:
  - `harr.html`: ~8 KB
  - `harr.css`: ~16 KB
  - `harr.js`: ~18 KB
  - **Total**: ~42 KB (far below the 150 KB limit).

### 4.2 Accessibility & Mobile-First
- Responsive CSS Grid and Flexbox layouts tested across:
  - **Mobile**: 375 × 812 px
  - **Tablet**: 768 × 1024 px
  - **Desktop**: 1280 × 800 px
- **Color Themes**:
  - Full Dark Mode and Light Mode support with WCAG AA/AAA contrast ratios.
  - Automatic `prefers-color-scheme` matching + persistent manual toggle.
- **Motion Accessibility**: `@media (prefers-reduced-motion: reduce)` disables all animations and transitions.
- **Semantic ARIA**: Proper landmarks, role tags, and keyboard focus states throughout.

### 4.3 Interactive Top-Down SVG Map of Harr
- Plotted from real landmark coordinates in `veloren-landmarks-extra.json` and resolved site landmarks.
- Dynamic color-coding for public works sites:
  - **Green (`#22c55e`)**: Completed projects.
  - **Amber (`#eab308`)**: Under active construction.
  - **Blue (`#0ea5e9`)**: Planned / Queued.
- **Discovery Fog of War**: Discovery locations (groves, hot springs, ruins) appear on the map **only after they are discovered** by players, maintaining the joy of exploration.
- Clickable landmark markers revealing coordinates, description, and status in an inspection sidebar.

### 4.4 Visual Research Dependency Tree
- Visual graph of all 30 civic technologies.
- SVG bezier curves connect prerequisite technologies to dependent breakthroughs.
- Interactive status indicators:
  - Researched (teal glow)
  - In Progress (pulse)
  - Available to Research (unlocked)
  - Locked (prerequisites pending)

### 4.5 Circular Goal Rings & "What Can I Do Now"
- **Goal Rings**: SVG stroke-dasharray circular indicators displaying village advancement metrics (e.g., Knowledge Shared, Sustainable Harvests, Public Architecture).
- **"What Can I Do Now" Panel**: Real-time actionable digest showing:
  - Public works currently waiting for a crew.
  - Immediate next steps for personal tasks.
  - Active village gathering or rhythm phase.
  - Pantry meal availability.
