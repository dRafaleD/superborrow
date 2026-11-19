# Superborrow

Duskline, Antigravity ve uyumlu VS Code tabanlı editörler için Tab ile kod
tamamlama eklentisi. Sürüm **0.3.14**, erken geliştirme önizlemesi.

> **Erken aşama.** Şu an öncelik Duskline'da Rust yazarken güvenilir Tab
> tamamlama. Önerileri kabul etmeden önce inceleyin ve derleyici ile testleri
> çalıştırın. Model yanlış kod önerebilir, bir bloğu tekrarlayabilir veya
> başka bir dilde yanıt verebilir. Filtreler bu hataların bir bölümünü yakalar.

| Kullanım | Destek durumu |
| --- | --- |
| Rust | Öncelikli dil. Tree-sitter bağlamı, trait ve metot imzaları, Rust odaklı istemler ve tekrar filtreleri. |
| TypeScript, JavaScript, TSX, JSX ve Python | Sözdizimi bağlamıyla tamamlama. Duskline'da bazı TS/JS önerileri dil servisinden gelir. |
| Diğer diller | Dil kimliği ve imleç çevresindeki metin üzerinden genel tamamlama. Doğruluk ve kapsam seçilen modele bağlıdır. |

### Sınırlar ve veri kullanımı

- Testler bağlamı, öneri filtrelerini ve köprü protokolünü kapsar. Günlük
  kullanımda her dil, model ve editör sürümü için eşdeğer doğrulama yoktur.
  Cursor ile karşılaştırmalı hız veya kalite üstünlüğü doğrulanmadı.
- Duskline seçili modeli yerel Ollama sürecinde çalıştırır. Model boyutu ve
  donanım gecikme ile bellek kullanımını etkiler. Antigravity kendi model
  sağlayıcısını ve hesabın kotasını kullanır. Bu entegrasyon host API'sine
  bağlıdır ve editör güncellemelerinde değişebilir.
- Bulut sağlayıcısı seçildiğinde kaynak kod parçaları ve ilgili bağlam
  sağlayıcıya gönderilebilir. `superborrow.exclude` dosya adlarına göre
  filtreler. Dosya içindeki sırları otomatik tespit etmez. `importContext`
  kapatılırsa açık olmayan TS/JS import dosyaları okunmaz.

## Neler çalışıyor?

- İmleç öncesi/sonrası bağlamla FIM; Qwen ve Codestral token düzenleri.
- Rust, TypeScript/TSX, JavaScript/JSX ve Python için artımlı tree-sitter analizi;
  diğer dillerde metin bağlamı. Açık belgelerden sembol imzaları ve son 10 düzenleme.
- llama.cpp `/infill`, Ollama `/api/generate`, yerel OpenAI uyumlu `/v1/completions`.
  SSE/NDJSON akışı, paylaşılan HTTP istemcisi, iptal ve zaman aşımı.
- Hayalet metin, belge olayları, debounce, kısa ömürlü öneri önbelleği ve mod seçici.
- Kullanılan adlara göre sıralanan export/tip/sınıf bağlamı; uzak importlar ve
  imleç yakınındaki hata/uyarılar. Aynı isteklerin ortak model çağrısı ve yazarken
  önerinin kalanını yeni çağrı olmadan yeniden kullanma.
- Güvenilen çalışma alanında açık olmayan doğrudan TS/JS importlarından sınırlı
  tip/API bağlamı: en fazla dört dosya, dosya başına 64 KB. Kapatmak için
  `superborrow.importContext: false`; dosya dışlamaları geçerlidir.
- Antigravity hesabındaki modellerin otomatik keşfi ve açılışta bağlantı;
  kalıcı model seçimi, `vscode.lm` ve özel eklenti adaptörü desteği.
- Türkçe/İngilizce yorumdan kod üretme: örneğin `// toplama fonksiyonu oluştur`
  yazıp alt satıra geçtiğinde hayalet metin önerilir; Tab ile kabul edilir.
- **Suggest Next Edit**: seçili kod veya mevcut satır için öneri, fark önizlemesi,
  kullanıcı uygulaması ve arada değişen belge için sürüm kontrolü.
- Rust'ta Tab imleçteki boşluğu doldurur. Satır veya blok değişiklikleri için
  **Suggest Next Edit** kullanılabilir. Rust trait metot imzaları ilgili bağlama eklenir.
- Sözdizimi ayrıştırıcısı olmayan dillerde de dil kimliği ve imleç çevresindeki
  metin kullanılır. Öneri kalitesi seçilen modelin dil desteğine bağlıdır.

**Suggest Next Edit** komutu seçili aralığı veya imlecin bulunduğu satırı işler.
Duskline, dil servisinin belirlediği import ve yeniden adlandırma önerilerini de
Tab ile sunabilir. Antigravity entegrasyonu, 1.11 eklentisinin dışa açtığı model
istemcisini kullanır. Hybrid mod, hata durumunda yerel sağlayıcıya dönebilir.

## Kurulum ve geliştirme

Rust edition 2024, Node.js 22+ ve npm gerekir. Windows'ta C/C++ derleme araçları
(tree-sitter için MSVC Build Tools), Linux'ta C derleyicisi gerekir.

```powershell
npm --prefix extension ci --ignore-scripts
cargo build --locked --manifest-path core-rust/Cargo.toml
npm --prefix extension test
cargo test --locked --manifest-path core-rust/Cargo.toml
cargo clippy --locked --manifest-path core-rust/Cargo.toml --all-targets -- -D warnings
npm --prefix extension run package:windows
& "$env:LOCALAPPDATA\Programs\Antigravity IDE\bin\antigravity-ide.cmd" --install-extension "$PWD\packages\superborrow-0.3.14-win32-x64.vsix" --force
```

Paket Windows x64 Rust çekirdeğini içerir. Kurulumdan sonra **Developer: Reload
Window** çalıştır. Güvenilen çalışma alanında motor otomatik başlar. Geliştirmede
bu klasörü açıp F5 kullanılabilir. Farklı binary: `superborrow.corePath`.

Antigravity'de **Antigravity Tab: Use Superborrow for Tab** komutu, Superborrow'u
doğrudan Antigravity/IDE sağlayıcısını kullanacak şekilde ayarlar ve çakışan yerleşik Tab sağlayıcısını kapatır.
Önceki yerleşik Tab ayarı saklanır; **Restore Antigravity Tab** onu geri yükleyip
Superborrow'u duraklatır. Yalnızca `tabEnabled` tercihi değiştirilir; model hesabı,
sohbet, izinler ve gizlilik tercihleri değiştirilmez. Bu geçiş kalıcı bir sağlayıcı
seçimidir; Pause tüm Superborrow önerilerini durdurur, yerleşik Tab'ı açmaz.

## Yerel model ayarı

### Duskline'da kullanım

VSIX'i Duskline'a kurup **Developer: Reload Window** çalıştırın. Duskline
profilinde eklenti sürümleri sınırlandırılıyorsa izinli sürüm olarak bu paketin
sürümünü ekleyin. **Superborrow: Select IDE Model** menüsünden önceden
indirilmiş modeli seçin. Öneri göründüğünde **Tab** ile kabul edin. Rust
dosyasında daha geniş değişiklikler için **Superborrow: Suggest Next Edit**
komutu fark önizlemesi açar.

### Diğer editörlerde yerel sunucu

Önceden indirilmiş FIM uyumlu bir model ve çalışan sunucu gerekir. Eklenti model
indirmez ve sunucuyu kendiliğinden kurmaz/başlatmaz. Ollama örneği:

```json
{
  "superborrow.mode": "hybrid",
  "superborrow.hybridPreference": "ide",
  "superborrow.ideModel": "auto",
  "superborrow.localApi": "ollama",
  "superborrow.endpoint": "http://127.0.0.1:11434/api/generate",
  "superborrow.model": "qwen2.5-coder:7b",
  "superborrow.fimFormat": "qwen"
}
```

llama.cpp için `localApi: "llamaInfill"`,
`endpoint: "http://127.0.0.1:8080/infill"`; model tokenizer'ını sunucu seçer.
OpenAI uyumlu yerel sunucu için `localApi: "openAi"`, tam `/v1/completions`
adresi ve model adı gerekir. Bu adaptör sohbet `/chat/completions` protokolünü
kullanmaz. Codestral ham token düzeni `fimFormat: "codestral"` ile seçilir.

Varsayılan mod **Antigravity (ide)**: istekler seçilen IDE modeline gider; yerel sunucuya başvuru veya yerel geri dönüş yapılmaz. Durum çubuğuna tıklayarak **Hybrid → Local → Antigravity** geçişi yapılır.
Local yalnızca yerel modele gider. Hybrid basit satırlarda yereli, blok başlangıcı,
büyük bağlam ve Next Edit için seçilmiş IDE modelini tercih eder. Sağlayıcı hata
verirse kullanılabilir diğer sağlayıcıyı dener. Yerel gecikme bütçesi aşıldığında
IDE seçiliyse ona geçer. `hybridPreference: "ide"` her dilde IDE'yi birincil,
yereli yedek yapar; `"local"` tersini yapar, `"auto"` bağlam sezgisini kullanır.

Antigravity'de `ideModel: "auto"`, açık hesabın model listesinden hızlı bir metin
modeli seçip açılışta bağlanır. **Select IDE Model** ile Gemini, Claude veya
hesabının açtığı diğer modellerden birini seçebilirsin; seçim kalıcıdır. API
çağrıları host eklentisinin kendi kimlik doğrulamasını kullanır. Genel VS Code
`vscode.lm` sağlayıcılarında ilk izin ve model seçimi kullanıcı komutuyla yapılır.

Dosya, kaydedilmemiş belge ve notebook hücrelerinde dil beyaz listesi yoktur.
AST desteği olmayan Go, Java, C#, C++, SQL, HTML, CSS ve diğer diller metin bağlamı
üzerinden aynı otomatik akışı kullanır. Sonuç kalitesi modele ve bağlama bağlıdır.
Yorum satırları da niyet olarak değerlendirilir: JS/TS `//`, Python `#`, SQL `--`,
CSS `/* */` ve HTML yorumları için ayrı bir komut gerekmez.

Yorum fonksiyonun ne yapacağını belirtmeli: Python'da
`# iki sayıyı toplayan bir fonksiyon oluştur` yazıp alt satıra geç.
Sadece `create function` davranış belirtmez; modelin rastgele boş fonksiyonlar
üretmek yerine öneri vermemesi istenir. Açık bir davranış isteğinde `pass`, TODO
ve boş gövde yerine uygulama istenir; açıkça istenen iskeletler desteklenir.

## Komutlar

| Komut | İşlev |
| --- | --- |
| Superborrow: Check Bridge | Bağlantıyı yeniden kur |
| Antigravity Tab: Switch Mode | Modlar arasında geç |
| Antigravity Tab: Pause / Resume | Tamamlamayı ve belge toplamayı durdur/başlat |
| Antigravity Tab: Select IDE Model | Antigravity / vscode.lm modelini kalıcı seç |
| Antigravity Tab: Use Superborrow for Tab | Doğrudan IDE model akışını aç, yerleşik Tab çakışmasını kaldır |
| Antigravity Tab: Restore Antigravity Tab | Önceki yerleşik Tab ayarını geri yükle, Superborrow'u duraklat |
| Antigravity Tab: Inspect Available Models | Modelleri, eklenti export adlarını ve aday komutları listele |
| Antigravity Tab: Suggest Next Edit | Seçili kod / mevcut satır için fark önizlemesi |
| Antigravity Tab: Show Diagnostics | Bağlantı ve hata kayıtlarını aç |

Hayalet metni editörün standart kabul tuşuyla (genellikle Tab) kabul edebilirsin.
Diğer tamamlama eklentileriyle aynı anda çalışması önerilerin görünmesini
etkileyebilir. IDE modunda model seçilmemişse açıklayıcı hata tanılarda görünür.

## Bağlam ve sınırlar

En çok 16 açık uygun belge senkronize edilir; aktif belge önceliklidir. Dosya başı
512 KiB, çekirdekte toplam 8 MiB sınırı vardır. Geçmiş ve prompt sınırlandırılır;
tam repo taraması yapılmaz. `.env*`, `*.pem`, `*.key`, `.git`, `node_modules`,
`target`, `dist` varsayılan olarak hariçtir; `superborrow.exclude` düzenlenebilir.
Bu dosya adı filtresi içerikteki tüm gizli bilgileri saptayan bir tarayıcı değildir.

Bağlam ve öneriler yalnızca bellekte tutulur. Prompt/kaynak metni loglanmaz.
Yerel HTTP istemcisi yalnızca loopback adres kabul eder; yönlendirme/proxy yoktur.
IDE/Hybrid modunda seçilmiş IDE sağlayıcısına kod bağlamı gönderilebilir.
Özel proje notları `superborrow.projectContext` ile açıkça girilir.

IDE modunda `superborrow.speculativeTyping` açıkken, yazılan metinle birebir
eşleşen eski model yanıtının kalan kısmı kullanılabilir. Eski tahmin ile güncel
istek birlikte yarışır; istemcide en çok iki model işi tutulur. Fazladan model
işi/kota tüketebilir; ayarı `false` yaparak sürüme bağlı tek istek akışına
dönebilirsin. Öneriler kendiliğinden uygulanmaz.

`maxContextBytes`, `maxTokens`, `debounceMs`, `requestTimeoutMs` ayarlanabilir.
İptal, değişen belge, kapanan dosya ve yeni istek eski yanıtların gösterilmesini
engeller. Next Edit sınırı `min(16 KiB, maxContextBytes / 4)` seçili UTF-8 metnidir.
IDE API'si standart bir çıktı token sınırı sunmadığından byte sınırı uygulanır.

## Doğrulama

CI, Windows ve Ubuntu üzerinde Rust format/Clippy/testleri, derlemeyi ve gerçek
Rust sürecine bağlanan Node testlerini çalıştırır. Yerel sağlayıcı testleri
kontrollü HTTP sunucularını kullanır; dış modele ihtiyaç duymaz.

Gerçek Ollama testi (model önceden kurulu olmalı):

```powershell
npm --prefix extension run smoke:local
```

Bu test dış model indirmez; `SUPERBORROW_MODEL` ile başka kurulu model seçilebilir.

İsteğe bağlı gerçek Antigravity testleri (Windows, kurulu IDE ve açık model hesabı):

```powershell
npm --prefix extension run test:host
```

Bu komut hesaptaki model kotasını kullanır; CI'de çalışmaz. Ayrı bir test profili
açar, gerçek model çağrılarını ve otomatik önerinin kabulünü sınar. Test sırasında
yerleşik Tab tercihini geçici değiştirip `finally` bloğunda geri yükler. Yalnızca
sentetik örnekler kullanılır; sonuçlar Git dışındaki `packages/host-live-*.json`
dosyasına yazılır. API seçim/üretim testleri ile gerçek editör kabul testi ayrıdır;
kabul testi yalnız Superborrow'un kabul bildirimi geldiyse geçer.

[Ölçüm notları](docs/validation.md), [mimari](docs/architecture.md),
[protokol](docs/protocol.md), [IDE adaptör sözleşmesi](docs/ide-adapter.md).

## Lisans

Bu depoda henüz bir lisans dosyası yoktur. Kaynak kodun görüntülenebilir olması
yeniden kullanım veya dağıtım izni vermez.
