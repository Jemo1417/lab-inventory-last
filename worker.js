export default {
  async fetch(request, env, ctx) {
    // إعدادات CORS للسماح لتطبيق الويب (PWA) بالاتصال بالوركر
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    // الاستجابة لطلبات التحقق المسبق من المتصفح (Preflight)
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return new Response("Only POST requests are allowed", { status: 405, headers: corsHeaders });
    }

    try {
      // استلام بيانات الصورة (Base64) من تطبيقك
      const { imageBase64 } = await request.json();

      if (!imageBase64) {
        return new Response(JSON.stringify({ error: "لم يتم توفير صورة" }), { 
          status: 400, 
          headers: { "Content-Type": "application/json", ...corsHeaders } 
        });
      }

      // إعداد الطلب لواجهة Gemini API
      const geminiApiKey = env.GEMINI_API_KEY; 
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiApiKey}`;

      const geminiPayload = {
        contents: [
          {
            parts: [
              { text: "قم بتحليل ملصق صندوق الكاشف المخبري هذا بدقة واستخرج البيانات التالية بصيغة JSON: اسم الكاشف، رقم التشغيلة (Lot Number)، وتاريخ الانتهاء (Expiry Date)." },
              {
                inline_data: {
                  mime_type: "image/jpeg",
                  data: imageBase64
                }
              }
            ]
          }
        ]
      };

      const geminiResponse = await fetch(geminiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(geminiPayload)
      });

      const data = await geminiResponse.json();

      // إرجاع النتيجة إلى التطبيق
      return new Response(JSON.stringify(data), {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders
        }
      });

    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), { 
        status: 500, 
        headers: { "Content-Type": "application/json", ...corsHeaders } 
      });
    }
  }
};
