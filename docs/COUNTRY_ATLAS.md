# Country research atlas

NemoWorld now offers an interactive local SVG atlas in Countries & areas. Select an outline or choose any of the 248 directory entries, then open its country research or agriculture evidence. Focus outline zooms to the selected geometry; the complete native selector supplies a keyboard navigation alternative.

## Source and coverage

Natural Earth 1:110m map units, public domain under https://www.naturalearthdata.com/about/terms-of-use/, pinned to creator repository commit `9380cca83db5f9aef52d5e762765100745f84b27`.

Source: https://raw.githubusercontent.com/nvkelso/natural-earth-vector/9380cca83db5f9aef52d5e762765100745f84b27/geojson/ne_110m_admin_0_map_units.geojson

Original SHA256: `718ac51d68ed2bf5de4f563fff2e2e045db706c1d3222805f3e317140a64213b`.

The local geometry contains 183 shapes representing 175 existing M49 directory entries, including repeated map units, plus four unassigned background shapes. Seventy-three directory entries have no outline at this scale. The full selector and searchable directory preserve access to them. ISO_A3_EH then ISO_A3 are matched to the existing directory; no parent-country fallback creates affiliations. France and French Guiana retain separate map units.

The equirectangular view is for orientation. These simplified de facto outlines do not establish legal boundaries, sovereignty, land area or institutional authority. Colours show retained agriculture sector series, not country performance, crop demand or research completion. Directory filters mute nonmatching outlines; the atlas selector still offers every entry.

## Operation and verification

The atlas loads a 153,711-byte local JSON file on demand, with bounded geometry validation. It needs no map tile service or third-party browser request. Selecting a place changes the preview and navigation only; it creates no account, task, country affiliation or submitted research.

Browser QA verified Nepal selection and focus, a Bhutan outline click, Singapore's selector fallback and country research navigation. At a 390-pixel viewport, page width remained 390 pixels and the map fit at 319.2 pixels; Nepal research navigation also worked. The temporary viewport was reset and isolated fixture closed. Source hashes and coverage, bounded view boxes, invalid data refusal, read-only static routes and saved-state preservation are covered by three new automated tests.
