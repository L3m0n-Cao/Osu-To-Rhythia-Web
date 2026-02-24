/**
 * osz2sspm v2 – browser port
 * Converts osu! beatmaps (.osz / .osu) to SSPM v2 (Sound Space Plus / Rhythia).
 */

(function () {
  'use strict';

  const OSU_W = 512.0;
  const OSU_H = 384.0;
  const OSU_HITCIRCLE = 1;
  const OSU_SLIDER = 2;
  const OSU_SPINNER = 8;

  const DIFF_TO_GROUP = {
    na: 0x00,
    easy: 0x01,
    medium: 0x02,
    hard: 0x03,
    logic: 0x04,
    tasukete: 0x05,
  };

  function createOsuMeta() {
    return {
      title: 'Unknown Title',
      artist: 'Unknown Artist',
      creator: 'Unknown Mapper',
      version: 'Converted',
      audio_filename: null,
      background_filename: null,
      mode: 0,
    };
  }

  /**
   * Parse .osu file text. Returns { meta, hitobjects }.
   * hitobjects: [ [x, y, time_ms, type], ... ]
   */
  function parseOsu(text) {
    const meta = createOsuMeta();
    const hitobjects = [];
    let section = null;
    const lines = text.split(/\r?\n/);

    function kv(line) {
      const i = line.indexOf(':');
      if (i === -1) return null;
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
    }

    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('//')) continue;

      if (line.startsWith('[') && line.endsWith(']')) {
        section = line.slice(1, -1).trim();
        continue;
      }

      if (section === 'General') {
        const pair = kv(line);
        if (!pair) continue;
        const [k, v] = pair;
        if (k === 'AudioFilename') meta.audio_filename = v;
        else if (k === 'Mode') meta.mode = parseInt(v, 10) || 0;
      } else if (section === 'Metadata') {
        const pair = kv(line);
        if (!pair) continue;
        const [k, v] = pair;
        if (k === 'Title') meta.title = v;
        else if (k === 'Artist') meta.artist = v;
        else if (k === 'Creator') meta.creator = v;
        else if (k === 'Version') meta.version = v;
      } else if (section === 'Events') {
        // Background: 0,0,"filename",xOffset,yOffset or 0,0,filename,xOffset,yOffset
        if (line.startsWith('0,') && !meta.background_filename) {
          const match = line.match(/^0,0,(?:"([^"]*)"|([^,]*))/);
          if (match) meta.background_filename = (match[1] || match[2] || '').trim() || null;
        }
      } else if (section === 'HitObjects') {
        const parts = line.split(',');
        if (parts.length >= 4) {
          try {
            const x = parseInt(parseFloatSafe(parts[0]), 10);
            const y = parseInt(parseFloatSafe(parts[1]), 10);
            const t = parseInt(parseFloatSafe(parts[2]), 10);
            const typ = parseInt(parts[3], 10);
            hitobjects.push([x, y, t, typ]);
          } catch (_) {}
        }
      }
    }

    return { meta, hitobjects };
  }

  function parseFloatSafe(s) {
    return parseFloat(s, 10);
  }

  /**
   * Parse slider end events from .osu text. Returns [ [end_time_ms, end_x, end_y], ... ].
   */
  function parseOsuSliderEndEvents(text) {
    let slider_multiplier = 1.0;
    const timing_points = []; // [time, beatLength, uninherited_is_red]
    const slider_lines = []; // [x, y, t, typ, repeat, pixelLength, last_point]

    let section = null;
    const lines = text.split(/\r?\n/);

    function kv(line) {
      const i = line.indexOf(':');
      if (i === -1) return null;
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
    }

    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('//')) continue;

      if (line.startsWith('[') && line.endsWith(']')) {
        section = line.slice(1, -1).trim();
        continue;
      }

      if (section === 'Difficulty') {
        const pair = kv(line);
        if (!pair) continue;
        const [k, v] = pair;
        if (k === 'SliderMultiplier') slider_multiplier = parseFloat(v, 10) || 1.0;
      } else if (section === 'TimingPoints') {
        const parts = line.split(',');
        if (parts.length >= 7) {
          try {
            const t = parseInt(parseFloatSafe(parts[0]), 10);
            const beat_len = parseFloat(parts[1], 10);
            const uninherited = parseInt(parts[6], 10);
            timing_points.push([t, beat_len, uninherited === 1]);
          } catch (_) {}
        }
      } else if (section === 'HitObjects') {
        const parts = line.split(',');
        if (parts.length < 6) continue;
        let x, y, t, typ;
        try {
          x = parseInt(parseFloatSafe(parts[0]), 10);
          y = parseInt(parseFloatSafe(parts[1]), 10);
          t = parseInt(parseFloatSafe(parts[2]), 10);
          typ = parseInt(parts[3], 10);
        } catch (_) {
          continue;
        }
        if ((typ & OSU_SLIDER) === 0) continue;

        const obj_params = parts[5];
        const slider_fields = obj_params.split('|');
        let last_point = null;
        if (slider_fields.length >= 2) {
          for (let i = slider_fields.length - 1; i >= 1; i--) {
            const token = slider_fields[i];
            if (token.indexOf(':') !== -1) {
              const [px, py] = token.split(':');
              last_point = [parseInt(parseFloatSafe(px), 10), parseInt(parseFloatSafe(py), 10)];
              break;
            }
          }
        }
        let repeat = parseInt(parts[6], 10);
        if (isNaN(repeat) || repeat < 1) repeat = 1;
        let pixel_len = parseFloat(parts[7], 10);
        if (isNaN(pixel_len)) pixel_len = 0;
        slider_lines.push([x, y, t, typ, repeat, pixel_len, last_point]);
      }
    }

    timing_points.sort((a, b) => a[0] - b[0]);

    function getRedBeatlength(atTime) {
      let beat = 500.0;
      for (const [tpT, beatLen, isRed] of timing_points) {
        if (tpT > atTime) break;
        if (isRed && beatLen > 0) beat = beatLen;
      }
      return beat;
    }

    function getSvMultiplier(atTime) {
      let sv = 1.0;
      for (const [tpT, beatLen, isRed] of timing_points) {
        if (tpT > atTime) break;
        if (!isRed && beatLen < 0) sv = beatLen !== 0 ? -100.0 / beatLen : 1.0;
      }
      if (sv <= 0) sv = 1.0;
      return sv;
    }

    const events = [];
    for (const [x, y, t, _typ, repeat, pixel_len, last_point] of slider_lines) {
      const beat_len = getRedBeatlength(t);
      const sv = getSvMultiplier(t);
      const vel = slider_multiplier * 100.0 * sv;
      if (vel <= 0) continue;
      const duration_one = (pixel_len / vel) * beat_len;
      const total_duration = duration_one * repeat;
      const end_t = Math.round(t + total_duration);
      let end_x, end_y;
      if (repeat % 2 === 0) {
        end_x = x;
        end_y = y;
      } else {
        if (last_point == null) {
          end_x = x;
          end_y = y;
        } else {
          end_x = last_point[0];
          end_y = last_point[1];
        }
      }
      events.push([end_t, end_x, end_y]);
    }
    return events;
  }

  function osuToSquare01(x, y) {
    const nx = x / OSU_W - 0.5;
    const ny = y / OSU_W - OSU_H / (2.0 * OSU_W);
    return [nx + 0.5, ny + 0.5];
  }

  function stretchMinmax(points) {
    if (!points.length) return points;
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    let min_x = Math.min(...xs);
    let max_x = Math.max(...xs);
    let min_y = Math.min(...ys);
    let max_y = Math.max(...ys);
    let rx = max_x - min_x;
    let ry = max_y - min_y;
    if (rx === 0) rx = 1.0;
    if (ry === 0) ry = 1.0;
    return points.map(([x, y]) => {
      const nx = Math.min(1, Math.max(0, (x - min_x) / rx));
      const ny = Math.min(1, Math.max(0, (y - min_y) / ry));
      return [nx, ny];
    });
  }

  function square01ToSsXy(sx, sy) {
    sx = Math.min(1, Math.max(0, sx));
    sy = Math.min(1, Math.max(0, sy));
    return [sx * 2.0, sy * 2.0];
  }

  /**
   * notes: [ [time_ms, x_float, y_float], ... ]
   */
  function hitobjectsToNotes(hitobjects, includeSliders, includeSpinners, includeSliderEnds, sliderEndEvents) {
    const base = [];
    for (const [x, y, t, typ] of hitobjects) {
      const isCircle = (typ & OSU_HITCIRCLE) !== 0;
      const isSlider = (typ & OSU_SLIDER) !== 0;
      const isSpinner = (typ & OSU_SPINNER) !== 0;
      if (isCircle || (includeSliders && isSlider)) {
        const [sx, sy] = osuToSquare01(x, y);
        base.push([t, sx, sy]);
      } else if (includeSpinners && isSpinner) {
        base.push([t, 0.5, 0.5]);
      }
    }
    if (includeSliderEnds && sliderEndEvents && sliderEndEvents.length) {
      for (const [endT, endX, endY] of sliderEndEvents) {
        const [sx, sy] = osuToSquare01(endX, endY);
        base.push([endT, sx, sy]);
      }
    }
    base.sort((a, b) => a[0] - b[0]);
    const stretched = stretchMinmax(base.map(([, sx, sy]) => [sx, sy]));
    const out = [];
    for (let i = 0; i < base.length; i++) {
      const [t, origSx, origSy] = base[i];
      const [nsx, nsy] = stretched[i];
      let rx, ry;
      if (origSx === 0.5 && origSy === 0.5) {
        [rx, ry] = square01ToSsXy(0.5, 0.5);
      } else {
        [rx, ry] = square01ToSsXy(nsx, nsy);
      }
      out.push([t, rx, ry]);
    }
    return out;
  }

  const textEncoder = new TextEncoder();

  function u16Str(s) {
    const b = textEncoder.encode(s);
    const len = Math.min(b.length, 65535);
    const out = new Uint8Array(2 + len);
    const view = new DataView(out.buffer);
    view.setUint16(0, len, true);
    out.set(b.subarray(0, len), 2);
    return out;
  }

  function buildMarkerDefinitions() {
    const u = u16Str('ssp_note');
    const out = new Uint8Array(1 + u.length + 1 + 1 + 1);
    out[0] = 1;
    out.set(u, 1);
    out[1 + u.length] = 1;
    out[1 + u.length + 1] = 0x07;
    out[1 + u.length + 2] = 0x00;
    return out;
  }

  function buildMarkers(notes) {
    const perNote = 4 + 1 + 1 + 4 + 4; // uint32 + byte + byte + float32 + float32
    const out = new Uint8Array(notes.length * perNote);
    const view = new DataView(out.buffer);
    for (let i = 0; i < notes.length; i++) {
      const [t, x, y] = notes[i];
      const off = i * perNote;
      view.setUint32(off, t >>> 0, true);
      out[off + 4] = 0;
      out[off + 5] = 0x01;
      view.setFloat32(off + 6, x, true);
      view.setFloat32(off + 10, y, true);
    }
    return out;
  }

  function buildStrings(mapId, mapName, songName, mappers) {
    const parts = [
      u16Str(mapId),
      u16Str(mapName),
      u16Str(songName),
    ];
    const view = new DataView(new ArrayBuffer(2));
    view.setUint16(0, mappers.length, true);
    parts.push(new Uint8Array(view.buffer));
    for (const m of mappers) parts.push(u16Str(m));
    const total = parts.reduce((acc, p) => acc + p.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
      out.set(p, offset);
      offset += p.length;
    }
    return out;
  }

  function concatU8(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
  }

  async function sha1Async(buffer) {
    const hash = await crypto.subtle.digest('SHA-1', buffer);
    return new Uint8Array(hash);
  }

  /**
   * Build SSPM v2 binary. Returns Uint8Array.
   */
  async function writeSspmV2(mapId, mapName, songName, mappers, difficultyGroup, audioBytes, coverBytes, notes) {
    const has_audio = audioBytes && audioBytes.length ? 1 : 0;
    const has_cover = coverBytes && coverBytes.length ? 1 : 0;

    const markerDefs = buildMarkerDefinitions();
    const markers = buildMarkers(notes);
    const markerBlock = concatU8(markerDefs, markers);
    const sha1 = await sha1Async(markerBlock.buffer);

    const lastMs = notes.length ? notes[notes.length - 1][0] : 0;
    const noteCount = notes.length;
    const markerCount = notes.length;

    const strings = buildStrings(mapId, mapName, songName, mappers);
    const customData = new Uint8Array(2);
    new DataView(customData.buffer).setUint16(0, 0, true);

    const audio = audioBytes && audioBytes.length ? new Uint8Array(audioBytes) : new Uint8Array(0);
    const cover = coverBytes && coverBytes.length ? new Uint8Array(coverBytes) : new Uint8Array(0);

    const headerLen = 4 + 2 + 4; // SS+m, version, reserved
    const metaLen = 20 + 4 + 4 + 4 + 1 + 2 + 1 + 1 + 1; // sha1, lastMs, noteCount, markerCount, diff, rating, has_audio, has_cover, requires_mod
    const ptrLen = 10 * 8;
    const totalLen =
      headerLen + metaLen + ptrLen +
      strings.length + customData.length + audio.length + cover.length +
      markerDefs.length + markers.length;

    const buf = new ArrayBuffer(totalLen);
    const view = new DataView(buf);
    const u8 = new Uint8Array(buf);
    let offset = 0;

    u8.set([0x53, 0x53, 0x2b, 0x6d], offset);
    offset += 4;
    view.setUint16(offset, 2, true);
    offset += 2;
    view.setUint32(offset, 0, true);
    offset += 4;

    u8.set(sha1, offset);
    offset += 20;
    view.setUint32(offset, lastMs >>> 0, true);
    offset += 4;
    view.setUint32(offset, noteCount >>> 0, true);
    offset += 4;
    view.setUint32(offset, markerCount >>> 0, true);
    offset += 4;
    view.setUint8(offset, difficultyGroup);
    offset += 1;
    view.setUint16(offset, 0, true);
    offset += 2;
    view.setUint8(offset, has_audio);
    offset += 1;
    view.setUint8(offset, has_cover);
    offset += 1;
    view.setUint8(offset, 0);
    offset += 1;

    const ptrOff = offset;
    offset += ptrLen;

    const stringsOff = offset;
    u8.set(strings, offset);
    offset += strings.length;

    const customOff = offset;
    u8.set(customData, offset);
    offset += customData.length;

    const audioOff = offset;
    u8.set(audio, offset);
    offset += audio.length;

    const coverOff = offset;
    u8.set(cover, offset);
    offset += cover.length;

    const mdefOff = offset;
    u8.set(markerDefs, offset);
    offset += markerDefs.length;

    const mkOff = offset;
    u8.set(markers, offset);

    view.setBigUint64(ptrOff + 0 * 8, BigInt(customOff), true);
    view.setBigUint64(ptrOff + 1 * 8, BigInt(customData.length), true);
    view.setBigUint64(ptrOff + 2 * 8, has_audio ? BigInt(audioOff) : 0n, true);
    view.setBigUint64(ptrOff + 3 * 8, has_audio ? BigInt(audio.length) : 0n, true);
    view.setBigUint64(ptrOff + 4 * 8, has_cover ? BigInt(coverOff) : 0n, true);
    view.setBigUint64(ptrOff + 5 * 8, has_cover ? BigInt(cover.length) : 0n, true);
    view.setBigUint64(ptrOff + 6 * 8, BigInt(mdefOff), true);
    view.setBigUint64(ptrOff + 7 * 8, BigInt(markerDefs.length), true);
    view.setBigUint64(ptrOff + 8 * 8, BigInt(mkOff), true);
    view.setBigUint64(ptrOff + 9 * 8, BigInt(markers.length), true);

    return u8;
  }

  function suggestOutputName(meta) {
    const safe = (meta.artist + '-' + meta.title + '-' + meta.version)
      .replace(/[^a-zA-Z0-9_\-]/g, '_')
      .slice(0, 64);
    return safe + '.sspm';
  }

  function downloadBlob(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // --- UI ---

  const inputFile = document.getElementById('input-file');
  const audioFile = document.getElementById('audio-file');
  const audioRow = document.getElementById('audio-row');
  const coverFile = document.getElementById('cover-file');
  const coverRow = document.getElementById('cover-row');
  const chartSelect = document.getElementById('chart-select');
  const chartRow = document.getElementById('chart-row');
  const outputPreview = document.getElementById('output-preview');
  const difficulty = document.getElementById('difficulty');
  const includeSliders = document.getElementById('include-sliders');
  const includeSpinners = document.getElementById('include-spinners');
  const includeSliderEnds = document.getElementById('include-slider-ends');
  const btnConvert = document.getElementById('btn-convert');
  const btnClear = document.getElementById('btn-clear');
  const logEl = document.getElementById('log');

  let state = {
    isOsz: false,
    entries: [], // { display, osuText, meta, audioBytes } for .osz; for .osu single entry, audioBytes from separate input
    zipEntries: null, // filename -> ArrayBuffer (only for .osz)
  };

  function log(msg) {
    logEl.value += msg + '\n';
    logEl.scrollTop = logEl.scrollHeight;
  }

  function setOutputPreview(name) {
    outputPreview.textContent = name ? 'Will save as: ' + name : 'Will save as: (choose input first)';
  }

  function updateChartSelect() {
    chartSelect.innerHTML = '';
    if (!state.entries.length) {
      chartSelect.disabled = true;
      setOutputPreview('');
      return;
    }
    state.entries.forEach((e, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = e.display;
      chartSelect.appendChild(opt);
    });
    chartSelect.disabled = false;
    chartSelect.value = '0';
    updateOutputPreviewFromSelection();
  }

  function updateOutputPreviewFromSelection() {
    const idx = chartSelect.value;
    if (idx === '' || !state.entries[idx]) {
      setOutputPreview('');
      return;
    }
    setOutputPreview(suggestOutputName(state.entries[idx].meta));
  }

  async function onInputChange() {
    const file = inputFile.files[0];
    state = { isOsz: false, entries: [], zipEntries: null };
    audioRow.style.display = 'none';
    coverRow.style.display = 'none';
    audioFile.value = '';
    coverFile.value = '';
    updateChartSelect();

    if (!file) {
      log('Cleared input.');
      return;
    }

    const name = file.name.toLowerCase();
    if (name.endsWith('.osz')) {
      if (typeof JSZip === 'undefined') {
        log('Error: JSZip not loaded. Check network.');
        return;
      }
      try {
        const zip = await JSZip.loadAsync(file);
        const osuNames = [];
        zip.forEach((path) => {
          if (path.toLowerCase().endsWith('.osu')) osuNames.push(path);
        });
        if (!osuNames.length) {
          log('Error: No .osu files found inside the .osz');
          return;
        }

        const entries = [];
        for (const path of osuNames) {
          const blob = await zip.file(path).async('blob');
          const text = await blob.text();
          const { meta, hitobjects } = parseOsu(text);
          if (meta.mode !== 0) continue;
          const display = meta.artist + ' - ' + meta.title + ' [' + meta.version + ']  (' + hitobjects.length + ' objects)';
          let audioBytes = null;
          if (meta.audio_filename) {
            const dir = path.replace(/[^/]*$/, '');
            const audioPathSameDir = dir + meta.audio_filename;
            const audioEntry = zip.file(audioPathSameDir) || zip.file(meta.audio_filename);
            if (audioEntry) {
              const ab = await audioEntry.async('arraybuffer');
              audioBytes = new Uint8Array(ab);
            }
          }
          let coverBytes = null;
          if (meta.background_filename) {
            const dir = path.replace(/[^/]*$/, '');
            const coverPathSameDir = dir + meta.background_filename;
            const coverEntry = zip.file(coverPathSameDir) || zip.file(meta.background_filename);
            if (coverEntry) {
              const ab = await coverEntry.async('arraybuffer');
              coverBytes = new Uint8Array(ab);
            }
          }
          entries.push({ display, osuText: text, meta, audioBytes, coverBytes });
        }

        if (!entries.length) {
          log('Error: No osu!standard (Mode:0) .osu found in the set.');
          return;
        }

        entries.sort((a, b) => {
          const na = (a.display.match(/\((\d+) objects\)$/) || [])[1];
          const nb = (b.display.match(/\((\d+) objects\)$/) || [])[1];
          return (parseInt(nb, 10) || 0) - (parseInt(na, 10) || 0);
        });

        state.isOsz = true;
        state.entries = entries;
        coverRow.style.display = 'flex';
        updateChartSelect();
        log('Loaded: ' + file.name);
        log('Found ' + state.entries.length + ' osu!standard difficulty file(s) inside the set.');
      } catch (e) {
        log('Error: ' + e.message);
      }
      return;
    }

    if (name.endsWith('.osu')) {
      try {
        const text = await file.text();
        const { meta, hitobjects } = parseOsu(text);
        if (meta.mode !== 0) {
          log('Error: Unsupported Mode:' + meta.mode + '. This supports osu!standard (Mode:0) only.');
          return;
        }
        const display = meta.artist + ' - ' + meta.title + ' [' + meta.version + ']  (from .osu)';
        state.entries = [{ display, osuText: text, meta, audioBytes: null, coverBytes: null }];
        audioRow.style.display = 'flex';
        coverRow.style.display = 'flex';
        updateChartSelect();
        log('Loaded: ' + file.name);
        log('Using the selected .osu file. Please select the audio file.');
      } catch (e) {
        log('Error: ' + e.message);
      }
      return;
    }

    log('Error: Input must be .osz or .osu');
  }

  async function onConvert() {
    if (!state.entries.length) {
      log('Error: Pick an input .osz/.osu first.');
      return;
    }

    const idx = chartSelect.value;
    const entry = state.entries[idx];
    if (!entry) {
      log('Error: Select a chart to export.');
      return;
    }

    let audioBytes = entry.audioBytes;
    if (state.isOsz === false && entry.meta.audio_filename) {
      const af = audioFile.files[0];
      if (!af) {
        log('Error: For a single .osu file, select the audio file.');
        return;
      }
      const ab = await af.arrayBuffer();
      audioBytes = new Uint8Array(ab);
    }

    if (entry.meta.audio_filename && (!audioBytes || !audioBytes.length)) {
      log('Error: Audio file not found. For .osz ensure the file is inside the package; for .osu select the audio file.');
      return;
    }
    if (!entry.meta.audio_filename && !audioBytes) {
      log('Error: No AudioFilename in .osu and no audio file selected.');
      return;
    }

    let coverBytes = entry.coverBytes || null;
    if (coverFile.files[0]) {
      const ab = await coverFile.files[0].arrayBuffer();
      coverBytes = new Uint8Array(ab);
    }

    const diffKey = difficulty.value.trim().toLowerCase();
    if (!(diffKey in DIFF_TO_GROUP)) {
      log('Error: Invalid SSPM difficulty group: ' + diffKey);
      return;
    }

    try {
      const { meta, hitobjects } = parseOsu(entry.osuText);
      if (meta.mode !== 0) throw new Error('Unsupported Mode:' + meta.mode);

      let sliderEndEvents = null;
      if (includeSliderEnds.checked) {
        sliderEndEvents = parseOsuSliderEndEvents(entry.osuText);
      }

      const notes = hitobjectsToNotes(
        hitobjects,
        includeSliders.checked,
        includeSpinners.checked,
        includeSliderEnds.checked,
        sliderEndEvents
      );

      if (!notes.length) throw new Error('No notes generated.');

      const mapId = (meta.artist + '-' + meta.title + '-' + meta.version).replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 64);
      const mapName = meta.title + ' [' + meta.version + ']';
      const songName = meta.artist + ' - ' + meta.title;
      const mappers = [meta.creator];

      const u8 = await writeSspmV2(
        mapId,
        mapName,
        songName,
        mappers,
        DIFF_TO_GROUP[diffKey],
        audioBytes || new Uint8Array(0),
        coverBytes || new Uint8Array(0),
        notes
      );

      const blob = new Blob([u8], { type: 'application/octet-stream' });
      const filename = suggestOutputName(meta);
      downloadBlob(blob, filename);

      log('');
      log('Wrote: ' + filename);
      log('Chart: ' + meta.version);
      log('Notes: ' + notes.length);
      log('Audio bytes: ' + (audioBytes ? audioBytes.length : 0));
      if (coverBytes && coverBytes.length) log('Cover bytes: ' + coverBytes.length);
    } catch (e) {
      log('Error: ' + e.message);
    }
  }

  function onClear() {
    state = { isOsz: false, entries: [], zipEntries: null };
    inputFile.value = '';
    audioFile.value = '';
    coverFile.value = '';
    audioRow.style.display = 'none';
    coverRow.style.display = 'none';
    updateChartSelect();
    logEl.value = '';
    log('Ready. Pick a .osz or .osu to begin.');
  }

  chartSelect.addEventListener('change', updateOutputPreviewFromSelection);
  inputFile.addEventListener('change', onInputChange);
  btnConvert.addEventListener('click', onConvert);
  btnClear.addEventListener('click', onClear);

  log('Ready. Pick a .osz or .osu to begin.');
})();
