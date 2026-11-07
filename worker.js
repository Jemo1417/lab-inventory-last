export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    // الاستجابة المسبقة للمتصفح (CORS)
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      const url = new URL(request.url);

      // 1. تهيئة جداول قاعدة البيانات الشاملة في D1 تلقائياً
      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS app_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          state_json TEXT NOT NULL,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `).run();

      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS audit_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_info TEXT,
          action_text TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `).run();

      // 2. جلب البيانات الكاملة عند فتح التطبيق (GET)
      if (request.method === "GET") {
        const row = await env.DB.prepare("SELECT state_json FROM app_state WHERE id = 1").first();
        return new Response(row ? row.state_json : JSON.stringify({ empty: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 200
        });
      }

      // 3. معالجة طلبات الذكاء الاصطناعي (Gemini AI) وحفظ البيانات (POST)
      if (request.method === "POST") {
        const bodyText = await request.text();
        let payload = {};
        try {
          payload = JSON.parse(bodyText);
        } catch (e) {
          return new Response(JSON.stringify({ error: "Invalid JSON" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }

        // =================================================================
        // أ) مسار الذكاء الاصطناعي الحقيقي (تحليل صور العلب، الأجهزة، الجداول، والمساعد الذكي)
        // =================================================================
        if (payload.action === "ai_analyze" || url.pathname === "/api/ai") {
          const apiKey = env.GEMINI_API_KEY;
          if (!apiKey) {
            return new Response(JSON.stringify({
              status: "error",
              message: "يرجى إضافة GEMINI_API_KEY في إعدادات Cloudflare Worker (Variables and Secrets)"
            }), {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
          }

          const { mode, promptText, imageBase64, mimeType } = payload;

          // تحديد التعليمات الذكية حسب نوع المهمة المطلوبة في TechnoLab
          let systemPrompt = promptText || "أنت المساعد الذكي لنظام TechnoLab في مستشفى الحياة أبها.";
          if (mode === "reagent_box") {
            systemPrompt = `قم بتحليل صورة علبة المحلول المخبري هذه واستخرج البيانات بدقة بصيغة JSON فقط بدون أي نص إضافي كالتالي:
            {"name": "اسم المحلول", "barcode": "رقم الباركود أو كود المنتج", "company": "الشركة المصنعة", "category": "كيمياء حيوية أو الهرمونات أو أمراض دم أو POCT أو بنك الدم", "lot": "رقم التشغيلة Lot", "expiry": "YYYY-MM-DD", "pack_size": 1}`;
          } else if (mode === "device_photo") {
            systemPrompt = `قم بالتعرف على هذا الجهاز المخبري من الصورة واستخرج بياناته بصيغة JSON فقط بدون أي نص إضافي كالتالي:
            {"name": "اسم وموديل الجهاز", "serial": "الرقم التسلسلي أو اسم الشركة المصنعة", "dept": "الكيمياء الحيوية (Core Lab) أو أمراض الدم (Hematology) أو الهرمونات والمناعة أو بنك الدم (Blood Bank) أو غازات الدم (POCT)", "reagents": "المحاليل والكونترولات المرتبطة به"}`;
          } else if (mode === "schedule_photo") {
            systemPrompt = `قم بقراءة صورة جدول شفتات الموظفين هذه واستخرج المناوبات بصيغة JSON Array فقط كالتالي:
            [{"name": "اسم الموظف", "emp_id": "الرقم الوظيفي إن وجد أو -", "period": "صباحي (07:30 - 15:30) أو مسائي (15:30 - 23:30) أو ليلي (23:30 - 07:30)", "bench": "القسم المكلف به", "days": "الأيام"}]`;
          }

          const parts = [{ text: systemPrompt }];
          if (imageBase64) {
            // إزالة بادئة base64 إن وجدت
            const cleanBase64 = imageBase64.includes(",") ? imageBase64.split(",")[1] : imageBase64;
            parts.push({
              inline_data: {
                mime_type: mimeType || "image/jpeg",
                data: cleanBase64
              }
            });
          }

          const geminiRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contents: [{ parts }],
                generationConfig: {
                  temperature: 0.2
                }
              })
            }
          );

          const geminiData = await geminiRes.json();
          const rawReply = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || "";

          // محاولة استخراج JSON نقي إذا كانت المهمة مسح صورة
          let parsedJson = null;
          if (mode === "reagent_box" || mode === "device_photo" || mode === "schedule_photo") {
            try {
              const cleaned = rawReply.replace(/```json/gi, "").replace(/```/g, "").trim();
              parsedJson = JSON.parse(cleaned);
            } catch (err) {
              parsedJson = null;
            }
          }

          return new Response(JSON.stringify({
            status: "ok",
            reply: rawReply,
            data: parsedJson
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 200
          });
        }

        // =================================================================
        // ب) مسار حفظ حالة النظام الكاملة (النوافذ الـ 10 + الـ 17 موظفاً + السجل)
        // =================================================================
        await env.DB.prepare(`
          INSERT INTO app_state (id, state_json, updated_at)
          VALUES (1, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(id) DO UPDATE SET
            state_json = excluded.state_json,
            updated_at = CURRENT_TIMESTAMP
        `).bind(bodyText).run();

        return new Response(JSON.stringify({ status: "ok", saved: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 200
        });
      }

      return new Response("Not Found", { status: 404, headers: corsHeaders });
    } catch (e) {
      return new Response(JSON.stringify({ status: "error", message: e.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
  }
};
