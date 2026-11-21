# reqlyproto (`reqly`)

مكتبة MTProto 2.0 خفيفة ومصمّمة لـ Cloudflare Workers وبيئات الحافة (edge).
الاسم الرسمي للحزمة هو **`reqlyproto`**، والاسم القصير **`reqly`** يُستخدم في التوثيق.

- الإصدار: **1.0.0**
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

## واجهة برمجية مختصرة
| التصدير | الغرض |
| --- | --- |
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
