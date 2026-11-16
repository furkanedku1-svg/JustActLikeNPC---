# Act Like NPC

Tarayıcıda oynanan, online ve çok oyunculu bir saklanma oyunu. Oyuncular NPC
kalabalığının içinde NPC gibi davranarak saklanır; bir oyuncu da kuş bakışından
onları bulmaya çalışır. Steam'deki "Just Act Natural" oyunundan ilham alır.

> **Durum:** Güncellendi — tek avcı yeteneği (`🧹 Kalabalığı Azalt`), çatı altı
> nişangâh penceresi, paylaşımlı elmaslar (10 sn yenilenme), 6 sabit heykel,
> orta fıskiye ve yeni NPC yapay zekâsı eklendi.

## Gereksinimler

- Node.js 18 veya üzeri

## Çalıştırma

```bash
npm install
npm start
# veya dosya değişiminde otomatik yeniden başlatma için:
npm run dev
```

Sunucu varsayılan olarak `http://localhost:3000` adresinde açılır.
Farklı bir port için `PORT` ortam değişkenini kullan:

```bash
# Windows PowerShell
$env:PORT = 4000; npm start

# Linux / macOS
PORT=4000 npm start
```

## Dosya yapısı

```
server.js          Express + Socket.io, lobi, maç/tur akışı, CONFIG (bütün sayılar)
game/Game.js       Bir turun mantığı: NPC yapay zekâsı, hareket, çarpışma,
                   görünürlük, atış, elmaslar, heykel, VIP ve yetenekler
game/maps.js       Harita verileri (Şehir Meydanı); yeni haritalar buraya eklenir
public/index.html  Ekranlar: takma ad, ana menü, lobi, nasıl oynanır modalı,
                   oyun (canvas + HUD + yetenek seçimi + tur sonu)
public/style.css   Arayüz stili (Fredoka fontu, sıcak renkler)
public/sound.js    Web Audio API ile kodda üretilen ses efektleri ve ses aç/kapa
public/client.js   Lobi mantığı, modal/ses kontrolleri ve socket olayları
public/game.js     Oyun çizimi: harita, fıskiye, 6 heykel, karakterler, elmaslar,
                   sis/puf efekti, çatı penceresi, interpolasyon, HUD, ses tetikleri
test/sim.js        Otomatik temel sunucu testi (npm test)
test/match.js      Otomatik 3 turlu tam maç testi (npm run test:match)
test/abilities.js  Otomatik yetenek, seçim fazı, görünürlük, NPC ve VIP testi (npm run test:abilities)
test/settings.js   Lobi ayarları + 5 tur × 1 dk maç testi (npm run test:settings)
test/unitConfig.js Birim testlerinde kullanılan ayarlar (CONFIG ile aynı değerler)
```

Oyunla ilgili bütün sayılar `server.js` başındaki `CONFIG` nesnesinde: tick hızı,
hızlar, NPC sayısı, atış yarıçapı, puanlar, kilit süreleri, tur süresi, görev
süreleri, elmas sayıları ve yetenek değerleri.

## Nasıl oynanır

**Lobi ayarları:** Lobideki "⚙️ Oyun Ayarları" bölümünü sadece lider değiştirir:
tur sayısı **1–10** (varsayılan 3), tur süresi **1/2/3/4/5 dk** (varsayılan 3) ve
**NPC yoğunluğu** (Az ×0,75 / Normal ×1 / Çok ×1,5; varsayılan Normal). Diğer
oyuncular ayarları görür; ayar değişince herkesin hazırlığı sıfırlanır. Lobide
seçili ayara göre "Bu ayarla yaklaşık 64 NPC olacak" yazar.

**Maç:** Avcılık sırası maç başında rastgele belirlenir; her tur sıradaki oyuncu
avcı olur. Tur sayısı oyuncu sayısından fazlaysa sıra baştan başlar (3 oyuncu,
5 tur → A, B, C, A, B). Turdan önce "Tur 2/5 · Avcı: Ayşe" bilgisi görünür. Her
turda NPC'ler, elmaslar, VIP'ler yeniden oluşturulur. Puanlar maç boyunca birikir.
Temel NPC sayısı `40 + 12 × saklanan sayısı`, en fazla 150'dir (1 → 52, 2 → 64,
4 → 88, 6 → 112, 9 → 148). Yoğunluk katıyla çarpıldıktan sonra da en fazla 150
(Çok seçeneğinde en fazla 200) NPC olur.

**Ağ:** Durum paketleri kısa tam sayı dizileridir: `[id, x, y, açıDerece, bayraklar?, halka%?]`
(bayrak 0 ve halka yoksa son elemanlar gönderilmez). Kıyafet/şapka/ten sadece tur
başında ve değiştiğinde gider. WebSocket mesajları sıkıştırılır (200 NPC'de paket
~4 KB → ~1,7 KB). Karakter çarpışması ızgara (grid) tabanlıdır.

**Saklanan:** WASD ya da ok tuşlarıyla yürür, görevleri **E** ile, yeteneğini **Q** (veya sol üstteki buton) ile kullanır. Görev
sırasında karakter durur; hareket edilirse görev iptal olur. Görevler sırayla açılır:

| Görev                         | Nasıl                                                                                                    | Puan       |
| ----------------------------- | -------------------------------------------------------------------------------------------------------- | ---------- |
| 💎 Elmas topla                | Haritadaki herhangi 3 paylaşımlı elmasın yanında E: anında alınır (~%40'ı kapalı alanlardadır, avcı kapalı alandaki elmasları da her zaman görür); alınan elmas 10 sn sonra rastgele yenilenir | +3 / elmas |
| 🗿 Heykeli incele             | Açık alandaki 6 küçük sabit heykelden herhangi birinin yanında E (3 sn); o heykelin şekli ve rengi değişir | +4         |
| 🎯 Gizli VIP'yi öldür         | Heykel görevi bitince VIP **aktif** olur ve avcı da onu (kapalı alanlarda bile) üstünde 👑 ve 3 çentikli can göstergesiyle görür. Yanındayken (30 br) her E 1 vuruş (0,5 sn arayla, toplam 3 vuruş) | +5         |
| Süre bitene kadar hayatta kal |                                                                                                          | +2         |

NPC'ler çatı altlarına girer (%24), elmas ve heykellere yaklaşıp 1–3 sn izler (%10),
açık alandaki 6 heykelden en yakınına gidip yüzünü döner ve oyuncunun incelemesiyle aynı ilerleme
halkasıyla 3 sn inceler (%15) veya açık alanda gezer (%51). Bir heykeli aynı anda en
fazla 3 karakter inceler. İlerleme halkası NPC'lerde sadece heykel incelerken (heykel
kenarına ≤ 25 br) ve çatı altında kıyafet değiştirirken görünür; diğer beklemelerde
halka yoktur. Elmas toplamazlar; NPC incelemesi heykeli değiştirmez, heykeli sadece
gerçek oyuncunun incelemesi değiştirir.

**Avcı:** Haritada karakteri yoktur, fare imleci nişangâhtır. Tıklanan noktaya
22 birim içindeki en yakın görünür karakter vurulur. Gerçek oyuncu: +5. Masum
NPC (henüz heykel görevi bitmemiş VIP dahil): −2 ve silah 2 sn kilitli. **Aktif bir
VIP'yi (👑) vurursa −10 puan** alır, silahı 2 sn kilitlenir, herkese bildirim gider ve
o saklanana tam canlı (3/3) yeni bir aktif VIP atanır. Boşa ateş: 0,5 sn kilit.
Çatılı alanların (Kapalı Çarşı, Kahvehane, Pasaj, Pazar Tentesi) altındaki karakterler
normalde gizlidir ve sadece nişangâhın 80 birimlik alanında görünür; ancak **kapalı
alanlardaki elmasları ve aktif VIP'leri avcı her zaman görür**.

**Yetenekler (tur başında 10 sn seçim):** Tur başlamadan saklananlar iki
karttan birini seçer (kimse başkasının seçimini görmez; seçmeyene süre bitince
rastgele verilir). Avcı seçim yapmaz; iki yetenek de her zaman avcıdadır:
- **🧹 Kalabalığı Azalt (`Q`, Avcı, turda 1 hak):** 1:30 ile tur süresinin yarısından kısa olanı kalınca açılır; o an hayatta olan NPC'lerin %20'sini puf efektiyle haritadan siler (gerçek oyuncular silinmez, VIP giderse yenisi atanır).
- **📡 Radar Bombası (`R`, Avcı, 15 sn bekleme, sınırsız hak):** `R` ile 130 birim yarıçaplı nişan moduna geçilir, haritada tıklanan yere 0,8 sn'de gölgesiyle düşer. Düştüğü anda daire içindeki canlı gerçek oyuncuların (çatı ve sis içindekiler dahil, NPC ve VIP'ler hariç) sayısını 3 sn boyunca büyük harflerle sadece avcıya gösterir; herkes "📡 Radar!" bildirimi alır.
- **👕 Kıyafet değiştirme (Saklanan, turda 2 hak):** Anında farklı kıyafet ve şapkaya geçer (NPC'ler de %30 olasılıkla çatı altında 1,2 sn durup değişir).
- **🌫️ Sis bombası (Saklanan, hak sınırı yok):** 90 birimlik alanda 10 sn boyunca avcıya opak sis bırakır; çatı penceresi içinde bile görüşü engeller. Atıldığı anda 15 sn bekleme başlar; butonun üstünde geri sayım ve dolan halka görünür, süre dolunca yeniden kullanılır.

**Tur bitişi ve Liderlik Tablosu:** Süre dolar, avcı bütün saklananları vurur ya da hayatta kalan
bütün saklananlar VIP görevini bitirir. 7 saniyelik tur sonu ekranında neden ve
tur puanları görünür; bütün turlar bitince 15 saniyelik **Liderlik Tablosu 🏆**
(🥇 🥈 🥉 madalyalar, eşit puanda ortak sıra, avcı/saklanan istatistik özeti ve
"Lobiye dön" butonu) açılır ve ardından herkes lobiye döner.

## Testler

```bash
npm test
```

`test/sim.js` kendi sunucusunu 3999 portunda açar, 10 sahte oyuncu bağlar, NPC
yoğunluğunu "Çok" yapar (200 NPC) ve NPC formülü, ID karıştırma, çatı görünürlüğü,
paket biçimi/boyutu, güncelleme hızı, NPC ilerleme halkası kuralı, hareket, atış,
puanlar ve tick süresini kontrol eder.

```bash
npm run test:match
```

`test/match.js` 3 sahte oyuncuyla tam bir maç oynar (yaklaşık 3 dakika): elmas
toplama, heykel, VIP, görev iptali, VIP yeniden atama, tur bitiş nedenleri,
sırayla avcılık, puan toplamları, final ve lobiye dönüş.

```bash
npm run test:abilities
```

`test/abilities.js` 3 sahte oyuncuyla seçim fazını, `🧹 Kalabalığı Azalt`
yeteneğini ve açılış süresini, 80 birimlik çatı penceresini, paylaşımlı elmas
yenilenmesini, sis (10 sn, 15 sn yeniden dolma) ve kıyafet yeteneklerini, NPC
oranlarını, NPC heykel incelemesini (halka kuralı, en fazla 3 kişi) ve VIP'nin 3
vuruşta ölmesini test eder.

```bash
npm run test:settings
```

`test/settings.js` lobi ayarlarını (sadece lider, hazırlık sıfırlama, herkesin
görmesi, NPC yoğunluğu ve NPC tahmini) test eder ve 5 tur × 1 dk'lık bir maç oynar (~5,5 dakika): tur sayısı,
tur süresi, döngüsel avcı sırası ve tur sonu "sıradaki tur" bilgisi.

Elle tam maç testi için en az 3 sekme aç (gizli sekmeler ayrı takma ad
kullanabilir), oda kur, kodla ya da davet linkiyle katıl, herkes "Hazırım"a
bassın. Testte süreleri kısaltmak için sunucuyu şu ortam değişkenleriyle
açabilirsin (saniye / milisaniye). `ROUND_TIME` verilirse lobideki tur süresi
ayarının yerine geçer:

```bash
# Windows PowerShell
$env:ROUND_TIME=30; $env:ROUND_END_MS=3000; $env:FINAL_MS=4000; $env:SKILL_PICK_TIME=5; npm start

# Linux / macOS
ROUND_TIME=30 ROUND_END_MS=3000 FINAL_MS=4000 SKILL_PICK_TIME=5 npm start
```
