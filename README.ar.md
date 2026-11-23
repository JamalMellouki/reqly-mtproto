# reqlyproto (`reqly`)

مكتبة MTProto 2.0 خفيفة ومصمّمة لـ Cloudflare Workers وبيئات الحافة (edge).
الاسم الرسمي للحزمة هو **`reqlyproto`**، والاسم القصير **`reqly`** يُستخدم في التوثيق.

- الإصدار: **2.0.0** ([الإصدارات](https://github.com/JamalMellouki/reqly-mtproto/releases))
- المؤلف: **Mellouki Jamal**
- المنصة: **Asynctric**
- الترخيص: **ASYNCTRIC-3.0**

## لماذا reqly؟
مكتبات MTProto الكاملة صُمّمت لعمليات طويلة الأمد: تبقي المقابس وحلقات التحديث
ومجمّعات الاتصال مفتوحة. على Workers هذا يعني بدءاً بطيئاً واستهلاكاً عالياً
لـ CPU. تُبقي reqly على الحد الأدنى المطلوب للوصول إلى ملفات Telegram:

- تحليل جلسات gramJS (`StringSession` v1)،
- تشفير رسائل MTProto 2.0 واشتقاق المفاتيح،
- نقل WebSocket مُعمّى (abridged)،
- codec صغير للـ Type Language.

**بدون تبعيات وقت تشغيل، بدون وحدات أصلية، بدون حالة مشتركة بين الطلبات.**

## التثبيت
```sh
npm install reqlyproto
```

## بداية سريعة
```ts
import { Reqly } from "reqlyproto"

const client = await Reqly.connect(sessionString)

const bytes = await client.getFile(
  { id, accessHash, fileReference, size },
  offset,
  limit,
)
client.close()
```

## الإصدارات
| الإصدار | الحالة | الاستخدام |
| --- | --- | --- |
| **2.0.0** | ✅ الأحدث | بث، SDK، تشفير WASM، توكنات، دعم مراكز البيانات |
| **1.0.0** | ♻️ محفوظ | عميل الطلب/الرد الأصلي الأصغر |

كلا الإصدارين متاحان كـ [إصدارات GitHub](https://github.com/JamalMellouki/reqly-mtproto/releases)
يمكن تثبيت أي منهما حسب الحاجة. السجل الكامل: [`CHANGELOG.md`](./CHANGELOG.md).

## SDK عالي المستوى
مضمن داخل الحزمة نفسها (لا حزمة إضافية):

```ts
import { createReqlySdk } from "reqlyproto"

const sdk = await createReqlySdk({ session: MT_SESSION, dcSessions: DC_SESSIONS })
const bytes = await sdk.download(document)
const stream = sdk.stream(document, { chunkSize: 512 * 1024 })
const hashes = await sdk.hashes(document)
sdk.close()
```

الدليل الكامل: [`docs/SDK.md`](./docs/SDK.md) · القياسات الحقيقية: [`docs/BENCHMARKS.md`](./docs/BENCHMARKS.md) · عرض تفاعلي: [`docs/showcase/index.html`](./docs/showcase/index.html).

## واجهة برمجية مختصرة
| التصدير | الغرض |
| --- | --- |
| `createReqlySdk(options)`, `ReqlySdk` | تنزيل وبث وتحقق وتوكنات ومعالج Worker |
| `Reqly.connect(session, options?)` | إنشاء عميل من سلسلة جلسة |
| `client.invoke(methodBytes)` | إرسال طريقة TL خام وإرجاع الرد |
| `client.getMessages(...)` | استخراج مراجع الملفات من قناة |
| `client.getFile(...)` | تنزيل مقطع من ملف (محاذاة 1MB ونهاية ملف آمنة) |
| `client.getFilesParallel(...)` | تجمع متوازٍ متكيّف (2→4 عمّال مع تراجع عند الفشل) |
| `client.close()` | إغلاق الاتصالات القابلة لإعادة الاستخدام |
| `parseSession`, `SessionStore` | أدوات الجلسات |
| `TlWriter`, `TlReader` | ترميز Type Language |
| `setIgeProvider` | استبدال تشفير AES-IGE |

## الخيارات
- `apiId` — معرّف Telegram من my.telegram.org (الافتراضي `1`).
- `dcSessions` — خريطة `dcId → جلسة` للتعامل مع `FILE_MIGRATE_X`.
- `freshSocket` — `true` يفتح WebSocket لكل استدعاء؛ `false` (الافتراضي) يُعيد استخدام الاتصال.

## الأخطاء
- `FileReferenceExpiredError` — مرّر دالة تحديث إلى `getFile`.
- `FileMigrateError` — يكشف `dcId`؛ وفّر `dcSessions` لإعادة المحاولة تلقائياً.

تحويل التفويض بين مراكز البيانات مُنفّذ بالكامل داخل reqly (بدون مكتبات MTProto
أخرى) عبر `scripts/gen-dc-sessions.ts`.

## حدود معروفة
- حد `upload.getFile` الأقصى هو 1MB لكل استدعاء (بروتوكول Telegram).
- إعادة توجيه CDN (`upload.fileCdnRedirect`) غير مدعومة في هذه النسخة.

## الترخيص
ASYNCTRIC-3.0 — استخدام وتعديل وتوزيع حر مع الحفاظ على هوية
**Mellouki Jamal** و**Asynctric**. يتضمن النسخة 3.0 بند عدم ضمان صريح.

---

Made by Mellouki Jamal for Asynctric.
