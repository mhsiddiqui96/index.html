# WA Business SaaS

একটা WhatsApp Business নাম্বার টিমের কয়েকজন মিলে চালানোর জন্য একটা ওয়েব অ্যাপ। মালিক অ্যাডমিন বা এজেন্ট যোগ করবেন, আর সবাই নিজের ইমেইল ও পাসওয়ার্ড দিয়ে লগইন করে গ্রাহকদের উত্তর দেবেন। অ্যাপটা Meta-র অফিসিয়াল WhatsApp Cloud API দিয়ে চলে। তাই নাম্বার ব্যান হওয়ার ঝুঁকি নেই, আর Linked device-এর মতো বারবার লগআউটও হয় না।

## কোন ভার্সনটা ব্যবহার করবেন?

| ভার্সন | কার জন্য | খরচ |
| --- | --- | --- |
| **[whatsapp-cloudflare/](whatsapp-cloudflare/README.md)** ⭐ | যাঁরা টেকনিক্যাল নন। এক ক্লিকে চালু হয়, কোনো সার্ভার বা কমান্ড লাগে না। | ফ্রি |
| [whatsapp-saas/](whatsapp-saas/README.md) | নিজের VPS সার্ভারে, বা Render.com-এ, Docker দিয়ে চালাতে চাইলে | মাসে প্রায় $৪–৭ |

দুটো ভার্সনের ফিচার একই:
- টিম ও রোল: মালিক, অ্যাডমিন আর এজেন্ট
- শেয়ার্ড ইনবক্স
- কোন চ্যাট কে দেখবেন তা ঠিক করে দেওয়া (চ্যাট অ্যাসাইন)
- টেমপ্লেট মেসেজ পাঠানো
- কুইক রিপ্লাই
- ড্যাশবোর্ড আর অ্যাক্টিভিটি লগ
- পুরো ইন্টারফেস বাংলায়

## এক ক্লিকে চালু করুন (ফ্রি)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/mhsiddiqui96/wa-business-saas/tree/main/whatsapp-cloudflare)

এরপর কী কী করতে হবে, ধাপে ধাপে লেখা আছে [whatsapp-cloudflare/README.md](whatsapp-cloudflare/README.md) ফাইলে।
