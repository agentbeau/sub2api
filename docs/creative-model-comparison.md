# PM Labs creative model comparison

One identical saved brief, max_completion_tokens 700, non-streaming. One call per text model; full response times include network and TLS. Explicit readiness start before each. No model/provider settings changed.

## Exact text prompt

Create a PM Labs landing-page concept in under 300 words. Give one distinctive headline (maximum 10 words), one supporting line (maximum 18 words), three scroll-linked story beats with concrete object choreography and visitor benefit, then four implementation/accessibility checks. PM Labs pairs Nathan’s judgment with AI agents doing practical work. Audience: people overwhelmed by everyday errands and unfinished ideas who do not want a call, judgment, or polished explanations. Show one useful next step, not a business dashboard or a claim that AI fixes everything. Visual taste: continuous charcoal-blue scene, terracotta notebook, realistic ivory paper objects, dimensional optically clear glass above the canvas with reflections and refraction, not frosted cards. Objects keep their material identity; motion follows physics and reverses when scrolling up. Use rich visual storytelling but little explanatory copy. Do not expose prompts or internal orchestration, suggest surveillance, require sensitive/work data, or add instructions telling visitors how to scroll. Preserve native scroll, readable live text, reduced-motion support and mobile performance.

## gpt-6-luna

HTTP/timing (first-byte, total seconds): 200 16.195500 16.195698

Usage: {"completion_tokens": 647, "total_tokens": 861, "prompt_tokens": 214, "prompt_tokens_details": {"cached_tokens": 0, "cache_write_tokens": 0, "cached_creation_tokens": 0}, "completion_tokens_details": {"reasoning_tokens": 366}}

**Headline:** A little less stuck, one step at a time

**Supporting line:** Nathan’s judgment and practical AI agents turn everyday friction into one useful next step.

**Story beats**

1. A terracotta notebook opens on a continuous charcoal-blue scene. A realistic ivory-paper note reads “Return library books.” Nothing asks for a call or a polished explanation.
2. A clear glass sheet catches and bends the light as an ivory slip slides beneath it: “Start here: put the books by the door.” The visitor gets a manageable next step, not another list.
3. The slip settles beside the notebook; a small paper bookmark marks the note. The scene stays calm and complete—ready when the visitor is, without implying the errand is done.

**Implementation and accessibility checks**

- Keep one continuous charcoal-blue canvas; preserve the notebook’s terracotta and paper’s ivory. Use optically clear, dimensional glass with realistic reflection and refraction—not frosted cards.
- Tie object movement to scroll position, with physically plausible easing; reverse it cleanly on upward scroll.
- Preserve native scrolling and readable live text. Provide equivalent content outside the visual sequence; never require motion to access the next step.
- Honor reduced-motion preferences and test mobile performance. Keep the experience useful without sensitive or work data; show no prompts, internal orchestration, or surveillance cues.

## gpt-6-astra

HTTP/timing (first-byte, total seconds): 200 28.105679 28.105900

Usage: {"completion_tokens": 419, "total_tokens": 633, "prompt_tokens": 214, "prompt_tokens_details": {"cached_tokens": 0, "cache_write_tokens": 0, "cached_creation_tokens": 0}, "completion_tokens_details": {"reasoning_tokens": 0}}

## Headline
**One loose end. A little more room.**

**Supporting line**
Nathan’s judgment, AI agents doing practical work. No call, no judgment, no need to explain it perfectly.

## Scroll-linked story

One continuous charcoal-blue scene; spare live text accompanies tangible objects.

### 1. Somewhere to put it
A terracotta notebook rests open beside three realistic ivory paper slips: “Return the lamp,” “Plan a weekend,” “Start that little idea.” As the page advances, the lamp slip slides toward the notebook, catching briefly against its raised binding before settling.

**Visitor benefit:** Pick one familiar loose end instead of organizing your whole life. Each slip is a selectable starting point; a plain text field also accepts a few words.

### 2. Less tangle, still your choice
A dimensional, optically clear glass lens hangs above the canvas. Moving across the chosen slip, it refracts paper fibers and casts restrained reflections. The paper stays opaque ivory; nothing transforms into a UI card. Two tucked paper tabs emerge: “Find the receipt” and “Check the return window.”

**Visitor benefit:** A vague errand becomes two manageable checks—not a promise that everything is handled.

### 3. One step leaves with you
The notebook opens slightly farther. An ivory takeaway sheet slides out, flexes over the cover edge, and rests within reach: “First: find the receipt.” Live controls offer **“Keep this step”** and **“Choose another.”**

**Visitor benefit:** Leave with one useful action, without uploading a receipt, booking a call, or explaining yourself.

## Implementation / accessibility checks
- Preserve native scrolling; map object positions deterministically so upward scrolling reverses physically coherent motion.
- Keep headings, choices, and takeaway text live, high-contrast, keyboard-accessible, and independent of canvas rendering.
- Respect reduced motion with static compositions and the same complete interaction flow.
- Cap mobile pixel density; simplify glass rendering and shadows, lazy-load assets, and provide a lightweight static fallback.

## gpt-6.1-terra

HTTP/timing (first-byte, total seconds): 200 9.476888 9.477288

Usage: {"completion_tokens": 308, "total_tokens": 522, "prompt_tokens": 214, "prompt_tokens_details": {"cached_tokens": 0, "cache_write_tokens": 0, "cached_creation_tokens": 0}, "completion_tokens_details": {"reasoning_tokens": 0}}

# The next step, made lighter.

Nathan’s judgment and practical AI agents help turn everyday loose ends into one useful next step.

### 01 · The loose end
An ivory envelope rests beside a terracotta notebook in a continuous charcoal-blue scene. As the page moves, the envelope slides open and a paper slip emerges: **“Return the library book.”** The visitor can choose an ordinary task without explaining themselves.

### 02 · The useful move
The slip settles on the notebook. Above it, a clear glass lens catches a reflection and refracts the paper beneath; its edges remain visibly dimensional, not frosted. A live-text suggestion appears: **“Put the book by your keys.”** One doable action replaces a polished plan.

### 03 · Take it with you
The notebook closes gently around the slip; the glass lens drifts aside and comes to rest. **“Copy next step”** offers a quiet exit—no call, account, judgment, or promise to solve everything.

### Implementation & accessibility checks
- Keep native scrolling; tie object movement to scroll position so it reverses naturally. Objects retain their paper, notebook, and glass identities throughout.
- Render all essential words and the copy button as selectable live text, with keyboard access, visible focus, and sufficient contrast.
- Honor reduced-motion preferences with a stable composition and immediate story-state changes.
- Optimize for mobile with lightweight assets, restrained effects, and a static glass fallback; test legibility and performance on real devices.

## gpt-6.1-sol

HTTP/timing (first-byte, total seconds): 200 21.012352 21.013039

Usage: {"completion_tokens": 398, "total_tokens": 612, "prompt_tokens": 214, "prompt_tokens_details": {"cached_tokens": 0, "cache_write_tokens": 0, "cached_creation_tokens": 0}, "completion_tokens_details": {"reasoning_tokens": 0}}

# Give one loose end somewhere to land.

Nathan’s judgment, AI agents doing practical work—without a call, a verdict, or a polished explanation.

### Three scroll-linked story beats

**1. The pile becomes one thing.**  
Across a continuous charcoal-blue canvas, realistic ivory scraps overlap a terracotta notebook: “return the lamp,” “weekend idea,” “find a repair shop.” As the page advances, one scrap slides free with paper-on-paper friction; the others remain unfinished, not magically resolved.  
**Visitor benefit:** Permission to start small. Live text asks: **“What’s one thing hanging around?”** An optional field accepts a short, non-sensitive description.

**2. One thing becomes workable.**  
The notebook opens against its binding. A dimensional, optically clear glass lens travels above the canvas, bending the paper’s edges beneath it and catching sharp reflections—not becoming a frosted interface. Beside the selected scrap, an ivory sheet settles: a brief, practical first move shaped by Nathan’s judgment and agent work.  
**Visitor benefit:** Something usable, not another system to manage. Example: **“Lamp return: first, check the return window.”**

**3. The next step comes within reach.**  
The sheet slides toward the foreground, stops with a slight flex, and rests beside the notebook. The lens moves aside; nothing obscures the text.  
**Visitor benefit:** One clear action: **“Make my first step.”** No booking flow or required explanation.

### Implementation / accessibility checks

- Preserve native scrolling; scroll-linked positions reverse coherently, with believable weight, contact, and occlusion.
- Keep all meaningful copy as readable live text; provide contrast, labels, keyboard access, and visible focus.
- Reduced motion presents three static compositions with identical content and actions.
- On mobile, simplify glass rendering and cap resolution; retain paper texture, responsive layout, and fast input.

## Image comparison

Identical complex still-image prompt; medium, 1536x1024, n=1, PNG. Sunburst reused exact prior successful call (33.803 seconds, 985 tokens); no new Sunburst charge. New base 2.6 and Flare calls below. These are still images, not GIFs.

gpt-image-2.6: 200 27.617583 28.569491; {"input_tokens": 384, "input_tokens_details": {"image_tokens": 0, "text_tokens": 384}, "output_tokens": 343, "output_tokens_details": {"image_tokens": 343, "text_tokens": 0}, "total_tokens": 727}

gpt-image-2.6-flare: 200 30.140035 30.991278; {"input_tokens": 384, "input_tokens_details": {"image_tokens": 0, "text_tokens": 384}, "output_tokens": 343, "output_tokens_details": {"image_tokens": 343, "text_tokens": 0}, "total_tokens": 727}

## Image prompt

Generate an image with the following prompt, dont change it(DO NOT CHANGE THIS PROMPT, IT'S ALREADY AN IMPROVED PROMPT) -
deliverable: one cinematic still keyframe concept for PM Labs, premium realistic 3D glass, not a screenshot of an app.
scene: an intimate charcoal-blue continuous tabletop world, a warm terracotta paper notebook on the left and a clear sculptural glass intelligence on the right, meeting in the middle.
subject and action: a few loose paper envelopes and unfinished handwritten-looking marks float from the notebook like a flock; slender transparent glass ribbons reach toward them and gently organize three envelopes into a clear path through space, leaving one playful envelope drifting freely. Keep the original envelopes identifiable throughout. A human-led thought becomes something usable, without surveillance imagery.
materials: optically clear thick glass with visible beveled edges, believable refraction of the background, subtle caustic reflections on the surface, tactile paper fibers and warm ink. Not matte frosted cards. Copper and soft ivory accents arise from the paper and light, no neon yellow.
implied motion frozen in this still: a gentle continuous loop with physically plausible easing, envelopes lifting and settling, glass ribbons softly flexing and reflections moving with them. No cuts, no flashing, no button instructions.
composition: three-quarter camera angle, strong dimensional foreground/midground/background separation, uncluttered upper-left negative space for future live text; the same continuous environment across the frame.
lighting: one warm side light and soft cool fill, controlled highlights preserve glass edges and paper detail.
text: no rendered text, no logos, no watermarks.
aspect ratio: 3:2
Avoid: flat vector shapes, generic dashboard boxes, excessive glare, oversaturation, watchful eyes, surveillance cameras, literal brains, human portraits. This is a visual metaphor, not an operational UI.