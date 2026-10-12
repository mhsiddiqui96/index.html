# সার্ভারে চালু করার গাইড

অ্যাপটা সার্ভারে চালানোর দুইটা উপায় আছে। যেটা আপনার জন্য সুবিধাজনক, সেটা বেছে নিন।

| | **উপায় ১: নিজের VPS** (সাজেস্টেড) | **উপায় ২: Render.com** |
| --- | --- | --- |
| মাসিক খরচ | প্রায় $4–6 (Hetzner, DigitalOcean, Contabo, Vultr) | প্রায় $7.25 (Starter প্ল্যান + ১ GB ডিস্ক) |
| কী লাগবে | একটা ডোমেইন বা সাবডোমেইন | কিছু লাগবে না (ফ্রি `onrender.com` লিংক পাবেন) |
| কাজের ধরন | একটা কমান্ড কপি-পেস্ট করতে হবে | পুরোটাই ব্রাউজারে ক্লিক করে |
| HTTPS | অটোমেটিক (Caddy + Let's Encrypt) | অটোমেটিক |
| ডাটা কোথায় থাকে | আপনার নিজের সার্ভারে | Render-এর ডিস্কে |

> ⚠️ ফ্রি হোস্টিং ব্যবহার করবেন না, যেমন Vercel, Netlify বা Render-এর ফ্রি প্ল্যান। এগুলোতে রিস্টার্টের সময় ডাটাবেস মুছে যায়, আর রিয়েল-টাইম ইনবক্সও চলে না।

---

## উপায় ১: নিজের VPS (এক কমান্ডে)

### ধাপ ১: একটা সার্ভার কিনুন

যেকোনো প্রোভাইডার থেকে **Ubuntu 22.04 বা 24.04** অপারেটিং সিস্টেমসহ একটা সার্ভার নিন, কমপক্ষে **1 GB RAM**। কয়েকটা অপশন:
- [Hetzner](https://www.hetzner.com/cloud): সবচেয়ে সস্তা, CX22 প্ল্যান প্রায় €4
- [DigitalOcean](https://www.digitalocean.com/): $6 Droplet
- [Vultr](https://www.vultr.com/), Contabo: এগুলোতেও হবে

সার্ভার তৈরি হলে আপনি তার **IP অ্যাড্রেস** আর **root পাসওয়ার্ড বা SSH key** পাবেন।

### ধাপ ২: ডোমেইন সার্ভারের দিকে পয়েন্ট করুন

আপনার ডোমেইনের DNS সেটিংসে গিয়ে (Namecheap, Cloudflare ইত্যাদি) একটা **A রেকর্ড** যোগ করুন:

| Type | Name | Value |
| --- | --- | --- |
| A | `desk` | আপনার সার্ভারের IP |

এতে আপনার অ্যাপের লিংক হবে `desk.আপনার-ডোমেইন.com`।

> Cloudflare ব্যবহার করলে প্রথমবার রেকর্ডের পাশের কমলা মেঘটা বন্ধ রাখুন (**DNS only**)। এতে HTTPS সার্টিফিকেট তৈরি হতে পারবে।

### ধাপ ৩: সার্ভারে লগইন করে কমান্ডটা চালান

কম্পিউটারের Terminal (Windows-এ PowerShell) খুলে সার্ভারে লগইন করুন:

```bash
ssh root@আপনার-সার্ভার-IP
```

তারপর এই কমান্ডটা পেস্ট করে Enter চাপুন:

```bash
curl -fsSL https://raw.githubusercontent.com/mhsiddiqui96/wa-business-saas/main/whatsapp-saas/deploy/install.sh | sudo bash
```

স্ক্রিপ্টটা আপনার কাছে তিনটা জিনিস জানতে চাইবে:
1. **ডোমেইন:** যেমন `desk.example.com`
2. **Meta App Secret:** এখন না থাকলে শুধু Enter চাপুন। পরে যোগ করা যাবে।
3. **অন্য বিজনেস সাইন-আপ করতে পারবে কিনা:** শুধু নিজের বিজনেসের জন্য চালালে `N` দিন। SaaS হিসেবে অন্যদের কাছে বিক্রি করতে চাইলে `y` দিন।

বাকি সব কাজ স্ক্রিপ্ট নিজেই করবে: Docker ইনস্টল, কোড ডাউনলোড, গোপন কী তৈরি, HTTPS চালু আর অ্যাপ স্টার্ট। শেষে স্ক্রিনে দেখাবে:
- আপনার অ্যাপের লিংক
- Meta Webhook-এর **Callback URL** আর **Verify Token**

এই দুইটা কপি করে রাখুন।

### ধাপ ৪: প্রথম অ্যাকাউন্ট খুলুন

ব্রাউজারে `https://desk.example.com` খুলুন। **"অ্যাকাউন্ট খুলুন"** চাপুন। প্রথম অ্যাকাউন্টটাই হবে মালিক (Owner)।

তারপর **টিম / অ্যাডমিন** পেজ থেকে অ্যাডমিন আর এজেন্ট যোগ করুন।

### পরে যা লাগতে পারে

সার্ভারে লগইন করে এই কমান্ডগুলো `/opt/wa-desk/whatsapp-saas` ফোল্ডার থেকে চালাবেন:

| কাজ | কমান্ড |
| --- | --- |
| লগ দেখা | `docker compose logs -f app` |
| Meta App Secret যোগ করা বা অন্য সেটিংস বদলানো | `nano .env` চালিয়ে বদলান, তারপর `docker compose up -d` |
| নতুন ভার্সনে আপডেট করা | install কমান্ডটা আবার চালান (ডাটা নষ্ট হবে না) |
| ব্যাকআপ নেওয়া | `bash deploy/backup.sh` (ব্যাকআপ জমা হবে `/opt/wa-desk-backups`-এ) |
| প্রতিদিন অটো ব্যাকআপ | `echo "0 3 * * * root bash /opt/wa-desk/whatsapp-saas/deploy/backup.sh" \| sudo tee /etc/cron.d/wa-desk-backup` |

---

## উপায় ২: Render.com (ব্রাউজার থেকে)

1. [render.com](https://render.com)-এ GitHub দিয়ে সাইন-আপ করুন।
2. **New → Blueprint** চাপুন। `mhsiddiqui96/wa-business-saas` রিপোটা কানেক্ট করুন।
3. Render নিজেই `render.yaml` ফাইলটা পড়ে নেবে। শুধু `META_APP_SECRET`-এর মান চাইবে। এখন না থাকলে খালি রাখুন।
4. **Apply** চাপুন। কয়েক মিনিট পর `https://wa-business-saas-xxxx.onrender.com` ধরনের একটা লিংক পাবেন।
5. Webhook-এর **Verify Token** দেখতে যান **Dashboard → wa-business-saas → Environment**-এ। সেখানে `WEBHOOK_VERIFY_TOKEN`-এর মান দেখা যাবে।

> চাইলে Render-এর **Settings → Custom Domains** থেকে নিজের ডোমেইনও যুক্ত করতে পারবেন।

---

## সার্ভার চালু হওয়ার পর WhatsApp কানেক্ট করুন

1. **Meta App → WhatsApp → Configuration → Webhook → Edit** এ যান।
   - **Callback URL** দিন: `https://আপনার-ডোমেইন/webhook`
   - **Verify Token** দিন: ইনস্টলের শেষে যেটা দেখিয়েছিল (Render-এ: Environment পেজের `WEBHOOK_VERIFY_TOKEN`)
   - তারপর **Verify and save** চাপুন।
2. একই পেজের **Webhook fields** অংশে **messages** Subscribe করুন।
3. **App settings → Basic → App secret** থেকে App Secret কপি করে সার্ভারে বসান। VPS-এ বসাবেন `.env` ফাইলে, Render-এ Environment পেজে।
4. অ্যাপে **WhatsApp সেটিংস** পেজে গিয়ে এই তিনটা বসান:
   - Phone Number ID
   - WhatsApp Business Account ID
   - Access Token

   তারপর **কানেকশন টেস্ট** চাপুন।
5. আপনার বিজনেস নাম্বারে অন্য একটা ফোন থেকে মেসেজ পাঠিয়ে দেখুন। মেসেজটা ইনবক্সে চলে এলে সব ঠিক আছে। ✅

## সমস্যা হলে

| সমস্যা | সমাধান |
| --- | --- |
| HTTPS কাজ করছে না, বা সাইট খুলছে না | DNS A রেকর্ড ঠিক IP-তে আছে কিনা দেখুন। সার্ভার প্রোভাইডারের ফায়ারওয়ালে 80 আর 443 পোর্ট খোলা আছে কিনা দেখুন। তারপর `docker compose logs caddy` চালিয়ে লগ দেখুন। |
| Meta বলছে "callback URL couldn't be validated" | Verify Token হুবহু মিলছে কিনা দেখুন। সাইট HTTPS-এ খুলছে কিনা দেখুন। |
| মেসেজ ইনবক্সে আসছে না | **messages** ফিল্ড Subscribe করা আছে কিনা দেখুন। সেটিংসে Phone Number ID ঠিক আছে কিনা দেখুন। `docker compose logs app`-এ `no workspace for phone_number_id` লেখা আছে কিনা দেখুন। |
| মেসেজ পাঠাতে গেলে এরর দেখাচ্ছে | Access Token-এর মেয়াদ বা পারমিশন দেখুন। টেস্ট নাম্বার হলে প্রাপকের নাম্বার Meta-তে "allowed recipients" তালিকায় যোগ করা আছে কিনা দেখুন। |
