// ============================================================
//  Harita verileri
//  Yeni bir harita eklemek için MAPS'e yeni bir nesne ekle
//  (ileride: Müze, Liman). Oyun mantığı ve çizim bu veriyi kullanır.
//
//  Engel türleri:
//    { type: 'circle', kind, x, y, r }
//    { type: 'rect',   kind, x, y, w, h }
//  Çatılar (roofs): dikdörtgen, karakterler altına girebilir.
//  Çeşme (fountain): ortadaki süs havuzu; dairesel engel olarak sayılır.
//  Heykeller (statues): 6 küçük sabit kaide + figür; dairesel engeldir.
// ============================================================

// Bir çatının 4 köşesine küçük direkler (engel) koyar
function roofPillars(roof, r = 7) {
  const xs = [roof.x + 10, roof.x + roof.w - 10];
  const ys = [roof.y + 10, roof.y + roof.h - 10];
  const out = [];
  for (const x of xs) for (const y of ys) out.push({ type: 'circle', kind: 'pillar', x, y, r });
  return out;
}

const SQUARE_ROOFS = [
  { id: 'carsi', name: 'Kapalı Çarşı', x: 30, y: 30, w: 280, h: 190, style: 'tiles', color: '#a8492f', accent: '#c4623f' },
  { id: 'kahve', name: 'Kahvehane', x: 1090, y: 30, w: 280, h: 190, style: 'planks', color: '#6e4527', accent: '#8a5a33' },
  { id: 'pasaj', name: 'Pasaj', x: 30, y: 580, w: 280, h: 190, style: 'glass', color: '#3f6178', accent: '#55819e' },
  { id: 'tente', name: 'Pazar Tentesi', x: 1090, y: 580, w: 280, h: 190, style: 'stripes', color: '#d0473f', accent: '#f4ecd8' },
];

const MAPS = {
  square: {
    id: 'square',
    name: 'Şehir Meydanı',
    width: 1400,
    height: 800,

    // Zemin: kare taş döşeme
    ground: { base: '#d8c9ae', alt: '#cfbe9f', grout: '#bfae8f', tile: 40 },

    // Yürüme yolları (sadece görsel)
    paths: [
      { x: 0, y: 372, w: 1400, h: 56 },   // yatay cadde
      { x: 672, y: 0, w: 56, h: 800 },    // dikey cadde
      { x: 310, y: 110, w: 362, h: 40 },  // çarşı → cadde
      { x: 728, y: 110, w: 362, h: 40 },  // cadde → kahvehane
      { x: 310, y: 650, w: 362, h: 40 },  // pasaj → cadde
      { x: 728, y: 650, w: 362, h: 40 },  // cadde → tente
    ],
    pathColor: '#e9dcc3',
    pathEdge: '#c9b48f',

    // Çeşmenin etrafındaki dairesel meydan (görsel)
    plaza: { x: 700, y: 400, r: 125 },

    // Ortadaki süs havuzu / çeşme (engel)
    fountain: { x: 700, y: 400, r: 42 },

    // 6 küçük sabit heykel (tamamı açık alanda, haritaya dengeli dağılmış ve çatı girişlerinden uzak)
    statues: [
      { id: 1, x: 450, y: 210, r: 14 },
      { id: 2, x: 950, y: 210, r: 14 },
      { id: 3, x: 450, y: 590, r: 14 },
      { id: 4, x: 950, y: 590, r: 14 },
      { id: 5, x: 220, y: 400, r: 14 },
      { id: 6, x: 1180, y: 400, r: 14 },
    ],

    obstacles: [
      // Heykelin çevresindeki 4 ağaç
      { type: 'circle', kind: 'tree', x: 560, y: 285, r: 20 },
      { type: 'circle', kind: 'tree', x: 840, y: 285, r: 20 },
      { type: 'circle', kind: 'tree', x: 560, y: 515, r: 20 },
      { type: 'circle', kind: 'tree', x: 840, y: 515, r: 20 },
      // Banklar
      { type: 'rect', kind: 'bench', x: 400, y: 336, w: 70, h: 16 },
      { type: 'rect', kind: 'bench', x: 930, y: 448, w: 70, h: 16 },
      { type: 'rect', kind: 'bench', x: 636, y: 190, w: 16, h: 70 },
      { type: 'rect', kind: 'bench', x: 748, y: 540, w: 16, h: 70 },
      // Çatı direkleri
      ...SQUARE_ROOFS.flatMap((r) => roofPillars(r)),
    ],

    roofs: SQUARE_ROOFS,
  },
};

const DEFAULT_MAP = 'square';

module.exports = { MAPS, DEFAULT_MAP };
