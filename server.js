require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const sharp   = require('sharp');
const axios   = require('axios');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const PORT   = process.env.PORT || 3006;
const GEMINI = process.env.GEMINI_API_KEY || '';

// ─── Outputs folder ───────────────────────────────────────────────────────────
const OUTPUTS_DIR = process.env.OUTPUTS_DIR || path.join(__dirname, 'outputs');
if (!fs.existsSync(OUTPUTS_DIR)) fs.mkdirSync(OUTPUTS_DIR, { recursive: true });

// In-memory history (newest first, capped at 200)
const history = [];
const MAX_HISTORY = 200;

fs.readdirSync(OUTPUTS_DIR)
  .filter(f => f.endsWith('.png'))
  .sort()
  .forEach(f => {
    const id = f.replace('.png', '');
    history.unshift({ id, filename: f, created_at: fs.statSync(path.join(OUTPUTS_DIR, f)).mtime.toISOString() });
  });
if (history.length > MAX_HISTORY) history.splice(MAX_HISTORY);

app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());
app.use('/outputs', express.static(OUTPUTS_DIR));
app.use(express.static(path.join(__dirname)));  // serves index.html

// ─── Trait maps ───────────────────────────────────────────────────────────────
const BACKGROUNDS = {
  'Crumpled Paper':  'crumpled white paper texture with natural folds, subtle shadows, and paper grain — clean and minimal',
  'Banana Forest':   'lush tropical forest packed with banana trees, golden bananas hanging in clusters, warm dappled sunlight filtering through leaves, rich green foliage',
  'Jungle Canopy':   'dense ancient jungle canopy, enormous thick leaves, exotic birds perched on branches, humid misty atmosphere, shafts of golden light cutting through the green',
  'Outer Space':     'deep cosmos — swirling purple and blue nebulas, thousands of distant stars, glowing ringed planets, cosmic dust clouds, cinematic space photography',
  'City at Night':   'rain-soaked neon-lit city street at night, glowing pink and teal reflections on wet pavement, Tokyo/cyberpunk aesthetic, bokeh lights, moody atmosphere',
  'Beach Sunset':    'golden hour beach, burning orange and pink sky, gentle waves crashing on shore, palm tree silhouettes, warm glow on the sand',
  'Cherry Blossom':  'Japanese cherry blossom garden in full bloom, soft pink petals drifting through the air, stone lanterns, calm pond reflection, soft spring light',
  'Crypto Bull Run': 'glowing multi-monitor trading setup showing green candles rocketing up, Bitcoin and ETH symbols floating in the air, electric blue and green atmosphere, wealth energy',
  'Treehouse':       'magical cozy wooden treehouse nestled in a giant ancient oak tree, string fairy lights glowing warmly, rope ladder, lush forest canopy below, golden hour light',
  'Underwater':      'crystal clear tropical underwater scene, vibrant coral reef in full color, exotic tropical fish swimming past, shafts of sunlight beaming down from the surface above',
};

const MOODS = {
  'Happy':   'happy and joyful — wide crayon-drawn smile, bright round eyes, cheerful expression',
  'Crying':  'bawling uncontrollably — thick bright blue teardrop streams painted flowing down the cheeks, mouth wide open wailing, furrowed brows',
  'Angry':   'angry — thick brows drawn hard downward in a V shape, tight grimacing mouth, intense stare',
  'Cool':    'cool and unbothered — half-lidded relaxed eyes, slight smirk, effortlessly chill',
  'Shocked': 'shocked — wide perfectly circular eyes, mouth dropped wide open in disbelief',
  'Sleepy':  'sleepy — droopy heavy half-closed eyes, relaxed drowsy expression, head slightly tilted',
};

// ─── Gemini Mojify ────────────────────────────────────────────────────────────
async function geminiMojify(imageBuffer, traits) {
  const imageB64 = imageBuffer.toString('base64');

  const bgDesc   = BACKGROUNDS[traits.background]  || BACKGROUNDS['Crumpled Paper'];
  const moodDesc = MOODS[traits.mood]               || MOODS['Happy'];

  const hatLine = traits.hat && traits.hat !== 'None'
    ? `HAT: The Mojo character wears a ${traits.hat} on top of its head. Render the ${traits.hat} with photorealistic texture and physical detail — it should look like a real tangible object resting on the cartoon figure.`
    : '';

  const itemLine = traits.heldItem && traits.heldItem !== 'Banana'
    ? `HELD ITEM: Mojo holds a ${traits.heldItem} in one hand. Render the ${traits.heldItem} with photorealistic detail, correct materials, and realistic texture.`
    : `HELD ITEM: Mojo holds a yellow banana in one hand. Render the banana with realistic photographic texture and natural yellow color.`;

  const accLine = traits.accessories && traits.accessories !== 'None'
    ? `ACCESSORIES: Mojo wears ${traits.accessories}. Render with realistic material detail — ${traits.accessories} should look physically real against the crayon figure.`
    : '';

  const prompt = `
Photo edit: Transform the person in this image into a Mojo character illustration placed inside a photorealistic scene.

MOJO CHARACTER (apply to the person):
Redraw the person as Mojo — a childlike crayon-drawn orange monkey character. Mojo features:
- Flat orange monkey face (keep the person's facial structure but recolor to orange)
- Thick scribbly orange crayon-drawn round ears on both sides of the head
- Small round crayon-drawn nose
- The person's original hair color and style redrawn in loose childlike crayon strokes on top
- The person's clothing and outfit redrawn in the same naive crayon marker illustration style on the Mojo body
- Curly orange crayon-drawn tail visible at the side or bottom
- Stick-thin crayon legs with small looped feet
All lines must be loose, scribbly, and imperfect — exactly like a 5-year-old drew it with crayons or thick markers. Flat colors with visible crayon texture throughout the entire figure.

EXPRESSION: ${moodDesc}

BACKGROUND:
Completely replace the original background with: ${bgDesc}
The background must be photorealistic with cinematic quality — rich natural lighting, film grain, fine texture detail, depth of field, and immersive atmosphere. It should look like a real photograph or high-quality concept art.

${hatLine}
${itemLine}
${accLine}

CRITICAL AESTHETIC:
The contrast between the photorealistic background and realistic items versus the naive childlike crayon Mojo figure is intentional and is the defining aesthetic of this image — like a hand-drawn cartoon character dropped into a real world photograph. Do not make the Mojo figure photorealistic. Keep it fully in crayon illustration style.

COMPOSITION: Full body Mojo character clearly visible and centered. Square 1:1 format.
`.trim();

  const res = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-preview-image-generation:generateContent?key=${GEMINI}`,
    {
      contents: [{
        parts: [
          { inlineData: { mimeType: 'image/png', data: imageB64 } },
          { text: prompt },
        ],
      }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    },
    { timeout: 120000 }
  );

  const candidate = res.data.candidates?.[0];
  if (candidate?.finishReason === 'PROHIBITED_CONTENT' || candidate?.finishReason === 'SAFETY') {
    throw new Error('Image couldn\'t be processed — try a different photo.');
  }
  const parts   = candidate?.content?.parts || [];
  const imgPart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));
  if (!imgPart) throw new Error('Generation failed — try a different image.');

  return Buffer.from(imgPart.inlineData.data, 'base64');
}

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    build: 'v1-mojify',
    gemini_key: GEMINI ? 'configured' : 'MISSING',
  });
});

// ─── History ──────────────────────────────────────────────────────────────────
app.get('/history', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({
    images: history.map(item => ({
      id:           item.id,
      result_image: `${base}/outputs/${item.filename}`,
      created_at:   item.created_at,
    })),
  });
});

// ─── Generate ─────────────────────────────────────────────────────────────────
app.post('/generate', upload.single('image'), async (req, res) => {
  const jobId = uuidv4();

  if (!req.file) return res.status(400).json({ error: 'No image uploaded', jobId });
  if (!GEMINI)  return res.status(500).json({ error: 'GEMINI_API_KEY not configured', jobId });

  const traits = {
    background:  req.body?.background  || 'Crumpled Paper',
    heldItem:    req.body?.heldItem    || 'Banana',
    hat:         req.body?.hat         || 'None',
    accessories: req.body?.accessories || 'None',
    mood:        req.body?.mood        || 'Happy',
  };

  try {
    // Prep input — square crop, 1024px, PNG
    const resized = await sharp(req.file.buffer)
      .resize(1024, 1024, { fit: 'cover', position: 'centre' })
      .png()
      .toBuffer();

    console.log(`[${jobId}] Mojifying → bg:"${traits.background}" hat:"${traits.hat}" item:"${traits.heldItem}" acc:"${traits.accessories}" mood:"${traits.mood}"`);

    const mojoBuffer = await geminiMojify(resized, traits);

    // Output — exactly 1000x1000 PNG
    const finalBuffer = await sharp(mojoBuffer)
      .resize(1000, 1000, { fit: 'cover', position: 'centre' })
      .png()
      .toBuffer();

    const filename   = `${jobId}.png`;
    const created_at = new Date().toISOString();
    fs.writeFileSync(path.join(OUTPUTS_DIR, filename), finalBuffer);

    history.unshift({ id: jobId, filename, created_at });
    if (history.length > MAX_HISTORY) history.pop();

    const base = `${req.protocol}://${req.get('host')}`;
    res.json({ success: true, jobId, result_image: `${base}/outputs/${filename}`, created_at });

  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data).slice(0, 400) : '';
    console.error(`[${jobId}] Error:`, err.message, detail);
    res.status(500).json({ error: err.message + (detail ? ' — ' + detail : ''), jobId });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const line = '─'.repeat(44);
  console.log(`\n╔${line}╗`);
  console.log(`║   🐒  MOJIFY BACKEND  🐒                   ║`);
  console.log(`╠${line}╣`);
  console.log(`║  Server  →  http://localhost:${PORT}            ║`);
  console.log(`║  Gemini  →  ${(GEMINI ? '✓ configured' : '✗ MISSING').padEnd(31)}║`);
  console.log(`╚${line}╝\n`);
});
