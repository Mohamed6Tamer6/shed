// One place to tweak the first-person hands. Every hand module reads from here.
export const HAND_CONFIG = {
  quality: new URLSearchParams(location.search).get('hands') === 'low' ? 'low' : 'high', // 'low' drops hair and fine normal detail

  skin: {
    tone: 0xb68b6f,          // base albedo (sRGB): the back-of-hand reference photo, a little less red (its light was warm)
    roughness: [0.5, 0.8],   // range across the skin
    sss: 0.4,                // fake subsurface: wrap + warm red at grazing angles and thin parts
    rim: 0.3,                // soft Fresnel rim
    sheen: 0.2,              // skin oil, must not look wet
    redness: 0.38,           // knuckles, fingertips, nail beds
    veins: 0.55,             // back of hand and wrist
    freckles: 0.3,
    detail: 1.0,             // strength of the photographed micro relief (lines, pores)
    tileBack: 0.036,         // metres covered by one tile of the back-of-hand detail map
    tilePalm: 0.03,          // same for the palm
  },

  hair: {
    density: 1.0,            // 1 = 3200 strands per hand
    color: 0x261a12,         // dark brown, almost black
    length: [0.004, 0.011],  // metres on the back of the hand; the forearm is longer, the fingers shorter
    forearmShare: 0.82,      // share of the strands that grow on the forearm (it has several times the area)
  },

  nails: {
    length: 1.0,             // 1 = short natural, >1 longer free edge
    clearcoat: 0.55,
  },

  anim: {
    idleBreath: 0.006,       // metres of slow arm rise/fall
    microMotion: 0.04,       // radians of finger noise when idle
    walkSwing: 0.05,         // metres of forward/back swing at walking speed
    runSwing: 0.11,          // at full run
    bob: 0.016,
    lateral: 0.012,
    wristRoll: 0.08,
    stiffness: 90,           // spring stiffness for hand lag and settle
    damping: 14,             // spring damping (lower = more overshoot)
    fistStagger: 0.045,      // seconds between fingers when closing a fist
    tremble: 0.0015,         // metres of tremble while a fist is held tight
  },
};
