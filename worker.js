export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    // الاستجابة المسبقة للمتصفح (Preflight)
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      const url = new URL(request.url);

      // ضمان وجود الجداول تلقائياً
      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS inventory (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          item_name TEXT NOT NULL,
          category TEXT DEFAULT 'عام',
          lot_number TEXT,
          expiry_date TEXT,
          quantity INTEGER DEFAULT 0,
          unit TEXT DEFAULT 'كارتلج',
          low_stock_threshold INTEGER DEFAULT 1,
          updated_by TEXT DEFAULT 'جمال عسيري',
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `).run();

      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          staff_name TEXT NOT NULL,
          action_text TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `).run();

      // 1. جلب جميع البيانات (GET)
      if (request.method === "GET") {
        const inventory = await env.DB.prepare("SELECT * FROM inventory ORDER BY quantity ASC, id DESC").all();
        const logs = await env.DB.prepare("SELECT * FROM logs ORDER BY id DESC LIMIT 20").all();
        
        return new Response(JSON.stringify({
          status: "success",
          inventory: inventory.results || [],
          logs: logs.results || []
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // 2. تنفيذ الأوامر: إضافة، تحديث كمية، أو حذف (POST)
      if (request.method === "POST") {
        const body = await request.json();
        const { action, staff_name } = body;

        if (action === "add") {
          const { item_name, category, lot_number, expiry_date, quantity, unit } = body;
          await env.DB.prepare(
            `INSERT INTO inventory (item_name, category, lot_number, expiry_date, quantity, unit, low_stock_threshold, updated_by)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
          ).bind(item_name, category || 'عام', lot_number || '-', expiry_date || '-', Number(quantity), unit || 'كارتلج', staff_name).run();

          await env.DB.prepare(
            `INSERT INTO logs (staff_name, action_text) VALUES (?, ?)`
          ).bind(staff_name, `أضاف صنف جديد: ${item_name} (الكمية: ${quantity})`).run();
        } 
        
        else if (action === "update_qty") {
          const { id, item_name, new_quantity, diff } = body;
          await env.DB.prepare(
            `UPDATE inventory SET quantity = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
          ).bind(Number(new_quantity), staff_name, Number(id)).run();

          const opType = diff > 0 ? `إضافة (+${diff})` : `سحب (${diff})`;
          await env.DB.prepare(
            `INSERT INTO logs (staff_name, action_text) VALUES (?, ?)`
          ).bind(staff_name, `قام بـ ${opType} على صنف: ${item_name} (المتبقي: ${new_quantity})`).run();
        } 
        
        else if (action === "delete") {
          const { id, item_name } = body;
          await env.DB.prepare(`DELETE FROM inventory WHERE id = ?`).bind(Number(id)).run();
          await env.DB.prepare(
            `INSERT INTO logs (staff_name, action_text) VALUES (?, ?)`
          ).bind(staff_name, `حذف الصنف: ${item_name} من النظام`).run();
        }

        const updatedInventory = await env.DB.prepare("SELECT * FROM inventory ORDER BY quantity ASC, id DESC").all();
        const updatedLogs = await env.DB.prepare("SELECT * FROM logs ORDER BY id DESC LIMIT 20").all();

        return new Response(JSON.stringify({
          status: "success",
          inventory: updatedInventory.results || [],
          logs: updatedLogs.results || []
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
    } catch (err) {
      return new Response(JSON.stringify({ status: "error", message: err.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
  }
};
