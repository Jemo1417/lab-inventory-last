/**
 * TechnoLab Full Enterprise Backend Worker (Cloudflare Workers + D1 SQLite)
 * Domain: Technolabs.online | مستشفى الحياة أبها
 * Done by Jamal Asiri (Admin)
 */

export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-User-Role, X-User-Id",
    };

    // الاستجابة المسبقة لطلبات المتصفح (CORS Preflight)
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const jsonResponse = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json;charset=UTF-8" },
      });

    try {
      const url = new URL(request.url);
      const path = url.pathname;

      // =========================================================================
      // 1. تهيئة وبناء جميع جداول قاعدة البيانات D1 تلقائياً (16 جدولاً كاملاً)
      // =========================================================================
      await initializeDatabaseTables(env.DB);

      // =========================================================================
      // 2. مسار جلب كافة بيانات النظام والمزامنة الشاملة (GET / أو /api/all)
      // =========================================================================
      if (request.method === "GET" && (path === "/" || path === "/api/all" || path === "/api/sync")) {
        // التحقق مما إذا كان هناك حالة محفوظة في جدول المزامنة الموحد أو الجداول التفصيلية
        const stateRow = await env.DB.prepare("SELECT state_json FROM app_state WHERE id = 1").first();

        const [
          staffRes,
          invRes,
          devRes,
          ctrlRes,
          critRes,
          auditStockRes,
          refRes,
          fridgeRes,
          suppRes,
          shiftRes,
          polRes,
          repRes,
          taskRes,
          handoverRes,
          notifRes,
          logsRes
        ] = await Promise.all([
          env.DB.prepare("SELECT * FROM staff ORDER BY id ASC").all(),
          env.DB.prepare("SELECT * FROM inventory ORDER BY id DESC").all(),
          env.DB.prepare("SELECT * FROM devices ORDER BY id DESC").all(),
          env.DB.prepare("SELECT * FROM controls ORDER BY id DESC").all(),
          env.DB.prepare("SELECT * FROM critical_results ORDER BY id DESC").all(),
          env.DB.prepare("SELECT * FROM smart_audit ORDER BY id DESC").all(),
          env.DB.prepare("SELECT * FROM ref_ranges ORDER BY id ASC").all(),
          env.DB.prepare("SELECT * FROM fridges ORDER BY id ASC").all(),
          env.DB.prepare("SELECT * FROM suppliers ORDER BY id ASC").all(),
          env.DB.prepare("SELECT * FROM shifts ORDER BY id DESC").all(),
          env.DB.prepare("SELECT * FROM policies ORDER BY id ASC").all(),
          env.DB.prepare("SELECT * FROM admin_reports ORDER BY id DESC").all(),
          env.DB.prepare("SELECT * FROM tasks ORDER BY id DESC").all(),
          env.DB.prepare("SELECT * FROM handovers ORDER BY id DESC").all(),
          env.DB.prepare("SELECT * FROM notifications ORDER BY id DESC").all(),
          env.DB.prepare("SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200").all()
        ]);

        if (stateRow && stateRow.state_json) {
          try {
            const parsedState = JSON.parse(stateRow.state_json);
            // دمج قائمة الموظفين الـ 17 دائماً لضمان عدم نقص أي موظف
            if (!parsedState.staff || parsedState.staff.length < 17) {
              parsedState.staff = staffRes.results;
            }
            return jsonResponse(parsedState);
          } catch (e) {}
        }

        return jsonResponse({
          status: "success",
          staff: staffRes.results || [],
          inventory: invRes.results || [],
          devices: devRes.results || [],
          controls: ctrlRes.results || [],
          criticalResults: critRes.results || [],
          smartAudit: auditStockRes.results || [],
          refRanges: refRes.results || [],
          fridges: fridgeRes.results || [],
          suppliers: suppRes.results || [],
          shifts: shiftRes.results || [],
          policies: polRes.results || [],
          comprehensiveReports: repRes.results || [],
          tasks: taskRes.results || [],
          handovers: handoverRes.results || [],
          notifications: notifRes.results || [],
          auditLogs: logsRes.results || []
        });
      }

      // =========================================================================
      // 3. مسارات العمليات التفصيلية والمزامنة الفورية (POST)
      // =========================================================================
      if (request.method === "POST") {
        const bodyText = await request.text();
        const payload = JSON.parse(bodyText || "{}");

        // أ) إذا كان الطلب يرسل حالة التطبيق الكاملة للمزامنة السريعة
        if (payload.staff && Array.isArray(payload.staff) && !payload.action) {
          await env.DB.prepare(`
            INSERT INTO app_state (id, state_json, updated_at)
            VALUES (1, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json, updated_at = CURRENT_TIMESTAMP
          `).bind(bodyText).run();

          return jsonResponse({ status: "synced", timestamp: new Date().toISOString() });
        }

        const { action, activeUser } = payload;
        const actorName = activeUser ? `${activeUser.name} (${activeUser.emp_id}) [${activeUser.role}]` : "Jamal Asiri (32726) [ADMIN]";

        // ب) إضافة أو تحديث محلول في المخزون (المختبر + المستودع العام)
        if (action === "save_reagent") {
          const r = payload.item;
          await env.DB.prepare(`
            INSERT INTO inventory (name, barcode, company, category, lot, expiry, pack_size, lab_boxes, lab_carts, wh_boxes, wh_carts, updated_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            r.name, r.barcode, r.company, r.category, r.lot, r.expiry,
            Number(r.pack_size || 1), Number(r.lab_boxes || 0), Number(r.lab_carts || 0),
            Number(r.wh_boxes || 0), Number(r.wh_carts || 0), actorName
          ).run();

          await logToDatabase(env.DB, actorName, `إضافة محلول جديد: ${r.name} (Lot: ${r.lot})`);
          return jsonResponse({ status: "ok", message: "تم حفظ المحلول في قاعدة البيانات" });
        }

        // ج) تحديث كمية الكارتلج أو التحويل بين المستودع العام والمختبر
        if (action === "update_stock") {
          const { id, lab_boxes, lab_carts, wh_boxes, wh_carts, item_name, note } = payload;
          await env.DB.prepare(`
            UPDATE inventory
            SET lab_boxes = ?, lab_carts = ?, wh_boxes = ?, wh_carts = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).bind(Number(lab_boxes || 0), Number(lab_carts || 0), Number(wh_boxes || 0), Number(wh_carts || 0), actorName, Number(id)).run();

          await logToDatabase(env.DB, actorName, note || `تحديث رصيد المحلول: ${item_name}`);
          return jsonResponse({ status: "ok" });
        }

        // د) إضافة جهاز مخبري (مع التعرف بالـ AI وصيانة يوم السبت وتحضير كال conCC)
        if (action === "save_device") {
          const d = payload.device;
          await env.DB.prepare(`
            INSERT INTO devices (name, serial, dept, saturday_maint, cal_control, reagents, ai_recognized, updated_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            d.name, d.serial || "SN-LAB", d.dept,
            d.saturdayMaint || "مجدولة ليوم السبت + تحضير conCC",
            d.calControl || "conCC + QC Level 1 & 2",
            d.reagents || "-", d.aiRecognized ? 1 : 0, actorName
          ).run();

          await logToDatabase(env.DB, actorName, `إضافة جهاز مخبري (${d.name}) وجدولة صيانة السبت وتحضير كال conCC`);
          return jsonResponse({ status: "ok" });
        }

        // هـ) إضافة كال جديد (conCC) أو كونترولات جديدة لاحقاً
        if (action === "save_control") {
          const c = payload.control;
          await env.DB.prepare(`
            INSERT INTO controls (name, device, lot, prep_date, status, updated_by)
            VALUES (?, ?, ?, ?, ?, ?)
          `).bind(c.name, c.device, c.lot, c.date, c.status || "مفعل ليوم السبت ✓", actorName).run();

          await logToDatabase(env.DB, actorName, `تحضير/إضافة كال أو كونترول: ${c.name} لجهاز ${c.device}`);
          return jsonResponse({ status: "ok" });
        }

        // و) إضافة أو تعديل موظف في قاعدة البيانات
        if (action === "save_staff") {
          const s = payload.staffMember;
          await env.DB.prepare(`
            INSERT INTO staff (emp_id, name, phone, hiring, email, section, role, title)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(s.emp_id, s.name, s.phone, s.hiring || "-", s.email || "-", s.section || "CORE LAB", s.role || "staff", s.title || "أخصائي مختبر").run();

          await logToDatabase(env.DB, actorName, `إضافة موظف للقاعدة: ${s.name} (${s.emp_id})`);
          return jsonResponse({ status: "ok" });
        }

        // ز) إصدار التقرير الشامل الحصري للأدمن (Jamal Asiri - Admin Only)
        if (action === "save_admin_report") {
          if (!activeUser || (activeUser.role !== "admin" && activeUser.emp_id !== "32726")) {
            return jsonResponse({ status: "forbidden", error: "إدخال وإصدار التقارير الشاملة مخصص حصرياً للأدمن جمال عسيري (32726)" }, 403);
          }
          const rep = payload.report;
          await env.DB.prepare(`
            INSERT INTO admin_reports (title, period, summary, issued_by, created_at)
            VALUES (?, ?, ?, ?, ?)
          `).bind(rep.title, rep.period, rep.summary, "Jamal Asiri (32726) - Admin 👑", rep.date || new Date().toISOString()).run();

          await logToDatabase(env.DB, actorName, `إصدار تقرير شامل معتمد: ${rep.title}`);
          return jsonResponse({ status: "ok" });
        }

        // ح) حفظ نتيجة حرجة (Panic Value)
        if (action === "save_critical") {
          const cr = payload.critical;
          await env.DB.prepare(`
            INSERT INTO critical_results (patient, test, notified_to, reported_by, reported_at)
            VALUES (?, ?, ?, ?, ?)
          `).bind(cr.patient, cr.test, cr.notifiedTo, actorName, cr.time).run();

          await logToDatabase(env.DB, actorName, `تبليغ نتيجة حرجة للمريض: ${cr.patient}`);
          return jsonResponse({ status: "ok" });
        }

        // ط) حفظ شفت أو اعتماد جدول الشفتات (Admin / Director Dr. Amr / Supervisor Faisal)
        if (action === "save_shift") {
          const sh = payload.shift;
          await env.DB.prepare(`
            INSERT INTO shifts (name, emp_id, period, bench, days, approved)
            VALUES (?, ?, ?, ?, ?, ?)
          `).bind(sh.name, sh.emp_id, sh.period, sh.bench, sh.days, sh.approved ? 1 : 0).run();

          await logToDatabase(env.DB, actorName, `تعيين شفت للموظف: ${sh.name}`);
          return jsonResponse({ status: "ok" });
        }
      }

      return jsonResponse({ status: "ready", app: "TechnoLab Enterprise API", domain: "Technolabs.online" });
    } catch (error) {
      return jsonResponse({ status: "error", message: error.message }, 500);
    }
  }
};

// دالة تسجيل الحركات في سجل الجودة (CBAHI Audit Trail)
async function logToDatabase(db, user, actionText) {
  await db.prepare(`
    INSERT INTO audit_logs (user, action, time) VALUES (?, ?, ?)
  `).bind(user, actionText, new Date().toLocaleString("en-GB")).run();
}

// دالة إنشاء جميع الجداول وإدخال البيانات الأساسية وموظفي المختبر وبنك الدم الـ 17
async function initializeDatabaseTables(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      state_json TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS staff (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      emp_id TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT,
      hiring TEXT,
      email TEXT,
      section TEXT,
      role TEXT,
      title TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      barcode TEXT,
      company TEXT,
      category TEXT,
      lot TEXT,
      expiry TEXT,
      pack_size INTEGER DEFAULT 1,
      lab_boxes INTEGER DEFAULT 0,
      lab_carts INTEGER DEFAULT 1,
      wh_boxes INTEGER DEFAULT 0,
      wh_carts INTEGER DEFAULT 0,
      updated_by TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      serial TEXT,
      dept TEXT,
      saturday_maint TEXT,
      cal_control TEXT,
      reagents TEXT,
      ai_recognized INTEGER DEFAULT 0,
      updated_by TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS controls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      device TEXT,
      lot TEXT,
      prep_date TEXT,
      status TEXT,
      updated_by TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS critical_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient TEXT NOT NULL,
      test TEXT NOT NULL,
      notified_to TEXT NOT NULL,
      reported_by TEXT,
      reported_at TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS smart_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_name TEXT NOT NULL,
      system_qty INTEGER,
      actual_qty INTEGER,
      audited_by TEXT,
      audited_at TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS ref_ranges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      test TEXT NOT NULL,
      normal TEXT,
      panic TEXT,
      dept TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS fridges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      section TEXT,
      temp TEXT,
      range TEXT,
      status TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company TEXT NOT NULL,
      contact TEXT,
      specialty TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS shifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      emp_id TEXT NOT NULL,
      period TEXT,
      bench TEXT,
      days TEXT,
      approved INTEGER DEFAULT 0
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS policies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      title TEXT NOT NULL,
      standard TEXT,
      owner TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS admin_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      period TEXT,
      summary TEXT,
      issued_by TEXT,
      created_at TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target TEXT NOT NULL,
      text TEXT NOT NULL,
      sender TEXT,
      reply TEXT DEFAULT '',
      time TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS handovers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user TEXT NOT NULL,
      text TEXT NOT NULL,
      acked INTEGER DEFAULT 0,
      time TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      text TEXT NOT NULL,
      date TEXT,
      read INTEGER DEFAULT 0
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user TEXT NOT NULL,
      action TEXT NOT NULL,
      time TEXT
    )`)
  ]);

  // إدخال الموظفين الـ 17 تلقائياً إذا كان الجدول فارغاً
  const staffCount = await db.prepare("SELECT COUNT(*) as cnt FROM staff").first();
  if (!staffCount || staffCount.cnt === 0) {
    const defaultStaff = [
      ["32726", "Jamal Asiri", "0505610803", "02-11-2024", "alalkmy777@gmail.com", "ADMINISTRATION", "admin", "Admin 👑 | مدير النظام ومشرف المختبر والجودة"],
      ["30001", "DR. AMR", "0500000000", "01-01-2024", "amr@technolabs.online", "LAB DIRECTOR", "director", "Director 🏛️ | مدير المختبر"],
      ["32731", "FAISAL YAHYA", "0541156185", "02-11-2024", "Fasial.foxy1@gmail.com", "CORE LAB", "supervisor", "Supervisor 🛡️ | مشرف المختبر"],
      ["30129", "ABDULLA ALSHARIF", "0535459126", "29-05-2025", "alsharif30129@gmail.com", "CORE LAB", "staff", "أخصائي مختبر - Core Lab"],
      ["30927", "REEM ALI", "0559204026", "16-10-2024", "reeeeo.1413@gmail.com", "CORE LAB", "staff", "أخصائية مختبر - Core Lab"],
      ["32728", "OMER TAHIR", "0502494505", "02-11-2024", "omermohtahir@gmail.com", "CORE LAB", "staff", "أخصائي مختبر - Core Lab"],
      ["34198", "SAQER ALI", "0550174018", "21-04-2025", "sqqr1818@gmail.com", "CORE LAB", "staff", "أخصائي مختبر - Core Lab"],
      ["34197", "RAGHAD QASEM", "0509358950", "20-04-2025", "raaghadqasem@gmail.com", "CORE LAB", "staff", "أخصائية مختبر - Core Lab"],
      ["36911", "QARAN SAEED", "0531274418", "29-12-2025", "Qaran.aldail@gmail.com", "CORE LAB", "staff", "أخصائي مختبر - Core Lab"],
      ["37234", "BUSHRA SAEED", "0502775505", "05-01-2026", "Bushrasaeedali@hotmail.com", "CORE LAB", "staff", "أخصائية مختبر - Core Lab"],
      ["37242", "ABDULMAJEED MUSHABAB", "0567680810", "05-01-2026", "alasiri.ab7@gmail.com", "CORE LAB", "staff", "أخصائي مختبر - Core Lab"],
      ["37520", "Dr. walla rabie", "0557876987", "01-02-2026", "-", "CORE LAB", "staff", "طبيب مختبر - Core Lab"],
      ["32693", "AMJAD YAHYA", "0568282318", "02-11-2024", "Amjad10231@gmail.com", "BLOOD BANK", "staff", "أخصائي بنك الدم - Blood Bank"],
      ["36246", "ABDU ALAYAFI", "0557737061", "16-11-2025", "Abdoaliabdallh1416@gmail.com", "BLOOD BANK", "staff", "أخصائي بنك الدم - Blood Bank"],
      ["36248", "RAWAN ALARAFJI", "0592662323", "28-10-2025", "rawanabdullah56@gmail.com", "BLOOD BANK", "staff", "أخصائية بنك الدم - Blood Bank"],
      ["36250", "KAWTHAR ASSIRI", "0532443539", "28-10-2025", "iikrii303@gmail.com", "BLOOD BANK", "staff", "أخصائية بنك الدم - Blood Bank"],
      ["37525", "Dr.mustafa yahya", "0509854263", "01-02-2026", "-", "BLOOD BANK", "staff", "طبيب بنك الدم - Blood Bank"]
    ];
    const stmts = defaultStaff.map(s =>
      db.prepare("INSERT INTO staff (emp_id, name, phone, hiring, email, section, role, title) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7])
    );
    await db.batch(stmts);
  }
}
