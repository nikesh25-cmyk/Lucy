# Veloren Words: Peaceful, Rich, and Non-Repetitive Text for Harr

## Overview
Stream `words` enriches the textual world of Harr inside Veloren, ensuring every resident speaks with an individual voice, research advances through an expanded 30-technology tree, the Harr Library catalogues 40 detailed field notes across the valley, and all text strictly avoids violent, competitive, or pay-to-win language.

## What Was Added and Updated

1. **Villagers (`content/veloren-villagers.json`)**:
   - 24 village residents across 6 roles (`farmer`, `builder`, `maker`, `scholar`, `courier`, `keeper`).
   - Sharpened `capabilities` and `limitations` to single-line descriptions (<= 240 chars) reflecting peaceful, cooperative craftsmanship.
   - 6 distinct, role-true, warm lines (`barks`) per resident (<= 160 chars each).
   - **144 unique barks** across the entire village: no two barks are alike anywhere in Harr.
   - Distinct voice textures:
     - Builders: practical, proud, safety-conscious, and cooperative.
     - Farmers: patient, observant of weather, soil, and seasons.
     - Makers: playful, hospitable, creative, and generous.
     - Scholars: curious, empirical, collaborative, and methodical.
     - Couriers: brisk, kind, helpful, and welcoming.
     - Keepers: hospitable, open-hearted, attentive, and community-focused.

2. **Harr Library (`content/veloren-discoveries.json`, `tools/gen-harr-places.py`)**:
   - 10 discovery sites around the village.
   - Each site includes a `notes` array containing 4 research-level field notes (**40 total field notes**).
   - Grounded in real-world-plausible natural history: soil core sampling, petrographic rock analysis, acoustic frequency of bird song, atmospheric clarity and scintillation, tardigrade cryobiosis, and laminar airflow patterns. No mysticism.

3. **Research Queue (`content/harr-research.json`)**:
   - Extended from 10 to **30 technologies** in a branching tree.
   - Strictly ordered: all prerequisites in `needs` appear earlier in the array.
   - Whitelisted effects preserved: `pantry_rate`, `pantry_cap`, `insight_per_find`.
   - Each technology includes a concise one-sentence story of what the village noticed upon discovery.

4. **Peaceful Tone and Positive Vocabulary (`content/veloren-events.json`, `harr-charter.json`)**:
   - Purely positive phrasing across all event descriptions and notes.
   - Zero occurrences of violent words (`kill`, `fight`, `attack`, `slay`, `weapon`, `enemy`, `battle`, `blood`, `dungeon`, `loot`, `raid`, `war`, `steal`).
   - Zero links, emails, contact details, or spending demands.

5. **Automated Validator (`tests/veloren-words.test.js`)**:
   - Verifies 24 villagers with 6 barks each, 144 unique barks, character limits.
   - Verifies 10 discoveries with 40 research notes.
   - Verifies research tree structure, ordering, and effect whitelist.
   - Verifies violent vocabulary prohibition across all content files.
   - 5 comprehensive tests, all passing.
