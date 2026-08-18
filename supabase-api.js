const API_MARKER = "__krp_supabase_api__";
const n = value => Number(String(value ?? "").replace(/,/g, "")) || 0;
const s = value => String(value ?? "");
const parseJson = value => { try { return typeof value === "object" ? value : JSON.parse(value || "{}"); } catch { return {}; } };
const round = value => Math.round((n(value) + Number.EPSILON) * 100) / 100;

const MAIN_HEADERS = ["Timestamp","INVOICE NO.","DATE","CONTACT NO. OR NAME","CUSTOMER NAME","BANK OWNER NAME","STATE","PURPOSE","SERVICE CHARGE REMARKS","LOGIN ID","DEALING AMOUNT","AMOUNT DENO","RECEIVED AMOUNT","ID ACTIVATION AMOUNT","UPLOADING OR SETUP AMOUNT","UTR / TRN NO.","PAYMENT STATUS","REMARKS","CREATED BY","ACTIVATION REQUIRED"];
const MONTH_HEADERS = ["DATE","MONTH","TOTAL ID","WORKING AMT","TRANSFER AMT","MONTHLY AMT","SETUP AMOUNT","REMARKS","CREATED BY","TIMESTAMP"];
const NOTE_HEADERS = ["Task Date","Contact No","State","Name","ID","Password","Task Description","Task Status","Payment Date","Dealing Amount","Received Amount","Remaining Amount","Payment Status","Reminder Date","CREATED BY","TIMESTAMP"];
const UDHARI_HEADERS = ["ENTRY ID","DATE","CUSTOMER NAME","MOBILE NO.","ADDRESS / STATE","TRANSACTION TYPE","DESCRIPTION","UDHAR DIYA AMT","PAYMENT MILA AMT","RUNNING BALANCE","DUE DATE","PAYMENT MODE","UTR / REFERENCE NO.","STATUS","REMINDER DATE","REMARKS","CREATED BY","TIMESTAMP","INTEREST RATE (%)","INTEREST TYPE","INTEREST START DATE","INTEREST CALCULATED TILL","INTEREST AMOUNT","TOTAL PAYABLE"];
const EXPENSE_HEADERS = ["EXPENSE ID","DATE","MONTH","CATEGORY","SUB CATEGORY","DESCRIPTION","PAYMENT MODE","PAID TO","AMOUNT","UTR / REFERENCE NO.","BILL / RECEIPT LINK","EXPENSE TYPE","PRIORITY","MONTHLY CATEGORY BUDGET","CATEGORY SPENT TILL NOW","CATEGORY BUDGET REMAINING","MONTH TOTAL EXPENSE","BUDGET USED %","ALERT STATUS","SMART REMARKS","ADDED BY","TIMESTAMP"];

function paramsFrom(input, init = {}) {
  const url = new URL(typeof input === "string" ? input : input.url, location.href);
  const out = Object.fromEntries(url.searchParams.entries());
  const body = init.body;
  if (body instanceof FormData || body instanceof URLSearchParams) for (const [k,v] of body.entries()) out[k] = v;
  else if (typeof body === "string") for (const [k,v] of new URLSearchParams(body).entries()) out[k] = v;
  return out;
}
function response(data) { return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }); }
function isoDate(value) {
  const m = s(value).match(/^(\d{2})[-\/]([0-9]{2})[-\/]([0-9]{4})$/);
  if (m) return new Date(+m[3], +m[2]-1, +m[1]);
  const i = s(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return i ? new Date(+i[1], +i[2]-1, +i[3]) : null;
}
function dateText(date) { return `${String(date.getDate()).padStart(2,"0")}-${String(date.getMonth()+1).padStart(2,"0")}-${date.getFullYear()}`; }
function stampText(value){const d=new Date(value);if(!value||isNaN(d))return"";const p=x=>String(x).padStart(2,"0");return `${p(d.getDate())}/${p(d.getMonth()+1)}/${String(d.getFullYear()).slice(-2)}, ${p(d.getHours())}:${p(d.getMinutes())}`;}
function mobile(value) { let x=s(value).replace(/\D/g,""); return x.length===12 && x.startsWith("91") ? x.slice(2) : x; }
function mainContactKey(value) { const phone=mobile(value); return phone||s(value).trim().replace(/\s+/g," ").toLowerCase(); }
async function all(client, table) { const {data,error}=await client.from(table).select("*").order("sequence_no"); if(error) throw error; return data||[]; }
async function idAt(client, table, index) { const rows=await all(client,table); const row=rows[n(index)]; if(!row) throw Error("Record not found"); return row.id; }

function mainRow(r) { const required=r.activation_required!==false,status=(!required||s(r.login_id).trim())?r.payment_status:"PENDING";return [r.created_at,r.invoice_no,r.entry_date,r.contact_name,r.customer_name,r.bank_owner,r.state,r.purpose,r.service_remarks,r.login_id,n(r.dealing_amount),s(r.amount_deno),n(r.received_amount),n(r.id_activation_amount),n(r.uploading_amount),s(r.utr_no),status,r.remarks,r.created_by_name||'',required]; }
function mainPayload(p) {
  const receivedAmount=n(p.receivedAmount), idActivationAmount=n(p.idActivationAmount);
  const loginId=s(p.loginId).trim();
  const activationRequired=!/^(false|0|no)$/i.test(s(p.activationRequired));
  const paymentStatus=(!activationRequired||loginId)?s(p.paymentStatus||p.status||"PENDING").toUpperCase():"PENDING";
  // Setup is a customer-ledger balance movement: payment adds credit and ID activation consumes it.
  const setupBalanceChange=paymentStatus==="REFUND"?0:round(receivedAmount-idActivationAmount);
  return {invoice_no:s(p.invoiceNo||p.invoice),entry_date:s(p.date),contact_name:s(p.contactName||p.contact),customer_name:s(p.customerName),bank_owner:s(p.bankOwner),state:s(p.state),purpose:s(p.purpose),service_remarks:s(p.serviceRemarks),login_id:loginId,dealing_amount:n(p.dealingAmount),amount_deno:s(p.amountDeno),received_amount:receivedAmount,id_activation_amount:idActivationAmount,uploading_amount:setupBalanceChange,utr_no:s(p.utrNo||p.utr),payment_status:paymentStatus,remarks:s(p.remarks),activation_required:activationRequired};
}
function monthRow(r) { return [r.entry_date,r.month,n(r.total_id),n(r.working_amount),n(r.transfer_amount),n(r.monthly_amount),n(r.setup_amount),r.remarks,r.created_by_name||'',stampText(r.created_at)]; }
function noteRow(r) { const remaining=Math.max(0,n(r.dealing_amount)-n(r.received_amount)); const status=remaining<=0&&n(r.dealing_amount)>0?"PAID":n(r.received_amount)>0?"PARTIAL":"PENDING"; return [r.task_date,r.contact_no,r.state,r.customer_name,r.login_id,r.password_text,r.task_description,r.task_status,r.payment_date,n(r.dealing_amount),n(r.received_amount),remaining,status,r.reminder_date,r.created_by_name||'',stampText(r.created_at)]; }
function notePayload(p) { return {task_date:s(p.taskDate),contact_no:s(p.contactNo),state:s(p.state),customer_name:s(p.name),login_id:s(p.loginId),password_text:s(p.password),task_description:s(p.taskDescription),task_status:s(p.taskStatus||"PENDING"),payment_date:s(p.paymentDate),dealing_amount:n(p.dealingAmount),received_amount:n(p.receivedAmount),reminder_date:s(p.reminderDate)}; }

function recalcTransactions(rows) {
  let prev=0; return [...rows].sort((a,b)=>(isoDate(a.entry_date)?.getTime()||9e15)-(isoDate(b.entry_date)?.getTime()||9e15)).map((r,i)=>{const total=n(r.working_amount)+prev; prev=total-n(r.transfer_amount)-n(r.monthly_paid); return {id:i,date:r.entry_date,month:r.month,totalId:n(r.total_id),workingAmt:n(r.working_amount),transferAmt:n(r.transfer_amount),monthlyPaid:n(r.monthly_paid),otherAmt:n(r.other_amount),remarks:r.remarks,totalPending:round(total),remainingAmt:round(prev),createdBy:r.created_by_name||'',timestamp:stampText(r.created_at)};});
}
function recalcUdhari(rows) {
  const today=new Date(); today.setHours(0,0,0,0); const accounts={};
  const sorted=[...rows].sort((a,b)=>((isoDate(a.entry_date)?.getTime()||9e15)-(isoDate(b.entry_date)?.getTime()||9e15))||(n(a.sequence_no)-n(b.sequence_no)));
  const accrue=(a,t,one=false)=>{if(!a.last||!t||a.principal<=0||a.rate<=0){if(t&&(!a.last||t>a.last))a.last=t;return;}const raw=Math.max(0,Math.floor((t-a.last)/86400000)),days=one&&raw===0&&t>=a.last?1:raw;if(days){a.interest+=a.type==="YEARLY"?a.principal*a.rate*days/36500:a.principal*a.rate*days/3000;a.last=t;}};
  const output=[];
  for(const r of sorted){const event=isoDate(r.entry_date)||today,key=mobile(r.mobile_no)||s(r.customer_name).trim().toLowerCase();const a=accounts[key]||{principal:0,interest:0,rate:0,type:"MONTHLY",last:event,due:null};accrue(a,event);const payment=s(r.transaction_type).toUpperCase()==="PAYMENT MILA";if(payment){let pay=n(r.payment_amount),ip=Math.min(a.interest,pay);a.interest-=ip;pay-=ip;a.principal=Math.max(0,a.principal-pay);}else{a.principal+=n(r.udhar_amount);a.rate=n(r.interest_rate);a.type=s(r.interest_type||"MONTHLY").toUpperCase();const start=isoDate(r.interest_start_date)||event;a.last=start>event?start:event;}const due=isoDate(r.due_date);if(due)a.due=due;const item={r,payment,principal:round(a.principal),interest:round(a.interest),total:round(a.principal+a.interest),due:a.due};output.push(item);a.latest=item;accounts[key]=a;}
  Object.values(accounts).forEach(a=>{accrue(a,today,true);if(a.latest){a.latest.principal=round(a.principal);a.latest.interest=round(a.interest);a.latest.total=round(a.principal+a.interest);a.latest.due=a.due;}});
  return output.map(({r,payment,principal,interest,total,due})=>{const status=total<=0?"PAID":due&&due<today?"OVERDUE":n(r.payment_amount)>0?"PARTIAL":"PENDING";return [r.id,r.entry_date,r.customer_name,r.mobile_no,r.address,r.transaction_type,r.description,n(r.udhar_amount),n(r.payment_amount),principal,r.due_date,r.payment_mode,r.reference_no,status,r.reminder_date,r.remarks,r.created_by_name||r.created_by_email,stampText(r.created_at),payment?0:n(r.interest_rate),payment?"":r.interest_type,payment?"":r.interest_start_date,dateText(today),interest,total];});
}
function expenseData(expenses,budgets){const names=["JANUARY","FEBRUARY","MARCH","APRIL","MAY","JUNE","JULY","AUGUST","SEPTEMBER","OCTOBER","NOVEMBER","DECEMBER"];const key=v=>{const m=s(v).match(/^\d{2}-(\d{2})-(\d{4})$/);return m?`${names[+m[1]-1]}-${m[2]}`:""};return expenses.map(r=>{const monthName=key(r.entry_date);const b=budgets.find(x=>s(x.month).toUpperCase()===monthName&&x.category===r.category&&x.created_by===r.created_by&&x.active);const budget=n(b?.monthly_budget);const related=expenses.filter(x=>key(x.entry_date)===monthName&&x.category===r.category&&x.created_by===r.created_by);const spent=related.reduce((a,x)=>a+n(x.amount),0);const monthTotal=expenses.filter(x=>key(x.entry_date)===monthName&&x.created_by===r.created_by).reduce((a,x)=>a+n(x.amount),0);const used=budget?round(spent*100/budget):0,limit=n(b?.warning_limit)||80;const alert=!budget?"NO BUDGET":used>=100?"OVER BUDGET":used>=limit?"WARNING":"SAFE";const remark=alert==="OVER BUDGET"?`${r.category} expense control karein`:alert==="WARNING"?`${r.category} budget limit ke paas hai`:"";return [r.id,r.entry_date,monthName,r.category,r.sub_category,r.description,r.payment_mode,r.paid_to,n(r.amount),r.reference_no,r.bill_link,r.expense_type,r.priority,budget,round(spent),round(budget-spent),round(monthTotal),used,alert,remark,r.created_by_name||r.added_by_email,stampText(r.created_at)];});}

async function route(client,user,p){
  const action=s(p.action);
  const createActions=new Set(["add","addRecord","addNotepad","saveRecord","saveUdhariRecord","saveExpense","saveExpenseBudget"]);
  const editActions=new Set(["update","updateStatusUtr","updateRecordField","updateRecord","updateNotepad","updateUdhariRecord","updateExpense"]);
  const deleteActions=new Set(["delete","deleteRecord","deleteNotepad","deleteUdhariRecord","deleteExpense"]);
  const settingsActions=new Set(["saveSettings","savePurposeSettings","saveDefaulterSettings"]);
  const requiredPermission=createActions.has(action)?"create":editActions.has(action)?"edit":deleteActions.has(action)?"delete":settingsActions.has(action)?"settings":"view";
  if(settingsActions.has(action)&&user.role!=="admin")throw Error("ADMIN permission required");
  if(user.role!=="admin"&&user.permissions?.[requiredPermission]!==true)throw Error(`${requiredPermission.toUpperCase()} permission required`);
  if(action==="getData"){const rows=await all(client,"main_records");return {success:true,headers:MAIN_HEADERS,data:rows.map(mainRow)};}
  if(action==="add"||action==="update"){const payload=mainPayload(p);let saved;if(action==="add"){const {data,error}=await client.from("main_records").insert(payload).select("*").single();if(error)throw error;saved=data;}else{const id=await idAt(client,"main_records",p.row);const {data,error}=await client.from("main_records").update(payload).eq("id",id).select("*").single();if(error)throw error;saved=data;}return {success:true,headers:MAIN_HEADERS,...(action==="update"?{rowIndex:n(p.row)}:{}),savedRow:mainRow(saved)};}
  if(action==="delete"){const id=await idAt(client,"main_records",p.row);const {error}=await client.from("main_records").delete().eq("id",id);if(error)throw error;return {success:true};}
  if(action==="updateStatusUtr"){
    const rows=await all(client,"main_records"), rowIndex=n(p.row), current=rows[rowIndex];
    if(!current)throw Error("Record not found");
    const key=mainContactKey(current.contact_name);
    const openingBalance=round(rows.filter(row=>mainContactKey(row.contact_name)===key).reduce((sum,row)=>sum+n(row.uploading_amount),0));
    const originalId=n(current.id_activation_amount), availableBeforeId=Math.max(0,openingBalance+originalId);
    let nextId=p.idActivationAmount===undefined?originalId:Math.max(0,n(p.idActivationAmount));
    if(openingBalance<=0)nextId=originalId;
    if(nextId>availableBeforeId)throw Error("ID Activation Amount recharge balance se zyada nahi ho sakta");
    const projectedBalance=Math.max(0,availableBeforeId-nextId);
    let nextStatus=s(p.status||"PENDING").toUpperCase();
    if((current.activation_required!==false&&!s(current.login_id).trim())||openingBalance<=0||projectedBalance<=0)nextStatus="PENDING";
    const nextSetup=nextStatus==="REFUND"?0:round(n(current.received_amount)-nextId);
    const {data,error}=await client.from("main_records").update({payment_status:nextStatus,utr_no:s(p.utr),id_activation_amount:nextId,uploading_amount:nextSetup}).eq("id",current.id).select("*").single();
    if(error)throw error;
    return {success:true,headers:MAIN_HEADERS,rowIndex,savedRow:mainRow(data),rechargeBalance:projectedBalance};
  }
  if(action==="getSettings"){const {data,error}=await client.from("business_settings").select("*").eq("id",1).maybeSingle();if(error)throw error;const x=data?{businessName:data.business_name,contactNumber:data.contact_number,emailAddress:data.email_address,gstin:data.gstin,businessAddress:data.business_address,accountHolderName:data.account_holder_name,accountNumber:data.account_number,ifsc:data.ifsc,upiId:data.upi_id,termsConditions:data.terms_conditions}:{};return {success:true,hasSettings:!!data,settings:x};}
  if(action==="saveSettings"){const x={id:1,business_name:s(p.businessName),contact_number:s(p.contactNumber),email_address:s(p.emailAddress),gstin:s(p.gstin),business_address:s(p.businessAddress),account_holder_name:s(p.accountHolderName),account_number:s(p.accountNumber),ifsc:s(p.ifsc),upi_id:s(p.upiId),terms_conditions:s(p.termsConditions),updated_by:user.uid};const {error}=await client.from("business_settings").upsert(x);if(error)throw error;return {success:true,settings:p};}
  if(action==="getTermsHistory"){
    const {data,error}=await client.from("business_terms_history").select("terms_text,changed_by_name,changed_at").order("changed_at",{ascending:false}).limit(50);
    if(error)throw error;
    return {success:true,history:(data||[]).map(x=>({terms:x.terms_text,changedBy:x.changed_by_name,changedAt:x.changed_at}))};
  }
  if(action==="getPurposeSettings"){
    const {data,error}=await client.from("business_settings").select("purpose_options,financial_year_options,state_options,bank_options").eq("id",1).maybeSingle();
    if(error)throw error;
    return {success:true,purposes:Array.isArray(data?.purpose_options)?data.purpose_options:[],years:Array.isArray(data?.financial_year_options)?data.financial_year_options:[],states:Array.isArray(data?.state_options)?data.state_options:[],banks:Array.isArray(data?.bank_options)?data.bank_options:[]};
  }
  if(action==="savePurposeSettings"){
    const purposes=parseJson(p.purposes),years=parseJson(p.years),states=parseJson(p.states),banks=parseJson(p.banks);
    if(!Array.isArray(purposes)||!Array.isArray(years)||!Array.isArray(states)||!Array.isArray(banks))throw Error("Invalid dropdown settings");
    const {error}=await client.from("business_settings").upsert({id:1,purpose_options:purposes,financial_year_options:years,state_options:states,bank_options:banks,updated_by:user.uid},{onConflict:"id"});
    if(error)throw error;
    return {success:true,purposes,years,states,banks};
  }
  if(action==="getDefaulterSettings"){
    const {data,error}=await client.from("business_settings").select("defaulter_overrides").eq("id",1).maybeSingle();
    if(error)throw error;
    return {success:true,overrides:Array.isArray(data?.defaulter_overrides)?data.defaulter_overrides:[]};
  }
  if(action==="saveDefaulterSettings"){
    const overrides=parseJson(p.overrides);
    if(!Array.isArray(overrides))throw Error("Invalid defaulter settings");
    const clean=overrides.slice(0,2000).map(x=>({key:s(x?.key).slice(0,180),remark:s(x?.remark).slice(0,300),excluded:!!x?.excluded})).filter(x=>x.key);
    const {error}=await client.from("business_settings").upsert({id:1,defaulter_overrides:clean,updated_by:user.uid},{onConflict:"id"});
    if(error)throw error;
    return {success:true,overrides:clean};
  }
  if(action==="getRecordsData"){const rows=await all(client,"monthly_records");return {success:true,headers:MONTH_HEADERS,data:rows.map(monthRow)};}
  if(["addRecord","updateRecordField","updateRecord","deleteRecord"].includes(action)&&!(p.rowIndex!==undefined&&p.data)){const table="monthly_records";if(action==="addRecord"){const {error}=await client.from(table).insert({entry_date:s(p.date),month:s(p.month),total_id:n(p.totalId),working_amount:n(p.working),transfer_amount:n(p.transfer),monthly_amount:n(p.monthly),setup_amount:n(p.setup),remarks:s(p.remarks)});if(error)throw error;}else{const id=await idAt(client,table,n(p.row)-2);if(action==="deleteRecord"){const {error}=await client.from(table).delete().eq("id",id);if(error)throw error;}else{const map={date:"entry_date",month:"month",totalId:"total_id",working:"working_amount",transfer:"transfer_amount",monthly:"monthly_amount",setup:"setup_amount",remarks:"remarks"};const update=action==="updateRecordField"?{[map[p.field]||p.field]:p.value}:{entry_date:s(p.date),month:s(p.month),total_id:n(p.totalId),working_amount:n(p.working),transfer_amount:n(p.transfer),monthly_amount:n(p.monthly),setup_amount:n(p.setup),remarks:s(p.remarks)};const {error}=await client.from(table).update(update).eq("id",id);if(error)throw error;}}return {success:true};}
  if(action==="getNotepadData"){const rows=await all(client,"notepad_tasks");return {success:true,headers:NOTE_HEADERS,data:rows.map(noteRow)};}
  if(action==="addNotepad"||action==="updateNotepad"){const payload=notePayload(p);if(action==="addNotepad"){const {error}=await client.from("notepad_tasks").insert(payload);if(error)throw error;}else{const id=await idAt(client,"notepad_tasks",p.row);const {error}=await client.from("notepad_tasks").update(payload).eq("id",id);if(error)throw error;}return {success:true};}
  if(action==="deleteNotepad"){const id=await idAt(client,"notepad_tasks",p.row);const {error}=await client.from("notepad_tasks").delete().eq("id",id);if(error)throw error;return {success:true};}
  if(action==="getMainStatusSummary"){
    const rows=await all(client,"main_records"),summary={PENDING:{ids:0,amount:0},SUCCESS:{ids:0,amount:0},REFUND:{ids:0,amount:0}};
    rows.forEach(r=>{const login=s(r.login_id).trim(),raw=s(r.payment_status||"PENDING").toUpperCase(),required=r.activation_required!==false,status=(required&&!login)?"PENDING":raw==="REFUND"?"REFUND":raw==="SUCCESS"?"SUCCESS":"PENDING";const ids=login?Math.max(1,login.split(/[,&\n]+/).map(x=>x.trim()).filter(Boolean).length):0;const amount=status==="PENDING"?Math.max(0,n(r.dealing_amount)-n(r.received_amount)):n(r.received_amount);summary[status].ids+=ids;summary[status].amount=round(summary[status].amount+amount);});
    return {status:"success",summary};
  }
  if(action==="getRecords"){return {status:"success",data:recalcTransactions(await all(client,"transactions"))};}
  if(["saveRecord","updateRecord","deleteRecord"].includes(action)){const table="transactions";if(action==="saveRecord"){const d=parseJson(p.data),{error}=await client.from(table).insert({entry_date:s(d.date),month:s(d.month),total_id:n(d.totalId),working_amount:n(d.workingAmt),transfer_amount:n(d.transferAmt),monthly_paid:n(d.monthlyPaid),other_amount:n(d.otherAmt),remarks:s(d.remarks)});if(error)throw error;}else{const id=await idAt(client,table,p.rowIndex);if(action==="deleteRecord"){const {error}=await client.from(table).delete().eq("id",id);if(error)throw error;}else{const d=parseJson(p.data),{error}=await client.from(table).update({entry_date:s(d.date),month:s(d.month),total_id:n(d.totalId),working_amount:n(d.workingAmt),transfer_amount:n(d.transferAmt),monthly_paid:n(d.monthlyPaid),other_amount:n(d.otherAmt),remarks:s(d.remarks)}).eq("id",id);if(error)throw error;}}return {status:"success"};}
  if(action==="getUdhariData"){return {success:true,headers:UDHARI_HEADERS,data:recalcUdhari(await all(client,"udhari_records"))};}
  if(["saveUdhariRecord","updateUdhariRecord","deleteUdhariRecord"].includes(action)){if(action==="deleteUdhariRecord"){const {error}=await client.from("udhari_records").delete().eq("id",p.entryId);if(error)throw error;}else{const d=parseJson(p.data),payload={entry_date:s(d.date),customer_name:s(d.customerName),mobile_no:mobile(d.mobileNo),address:s(d.address),transaction_type:s(d.transactionType||"UDHAR DIYA"),description:s(d.description),udhar_amount:n(d.udharAmount),payment_amount:n(d.paymentAmount),due_date:s(d.dueDate),payment_mode:s(d.paymentMode),reference_no:s(d.referenceNo),reminder_date:s(d.reminderDate),remarks:s(d.remarks),interest_rate:s(d.transactionType).toUpperCase()==="PAYMENT MILA"?0:n(d.interestRate),interest_type:s(d.transactionType).toUpperCase()==="PAYMENT MILA"?"":s(d.interestType||"MONTHLY"),interest_start_date:s(d.transactionType).toUpperCase()==="PAYMENT MILA"?"":s(d.interestStartDate||d.date),created_by_email:user.email||""};const q=action==="saveUdhariRecord"?client.from("udhari_records").insert({...payload,id:d.entryId||crypto.randomUUID()}):client.from("udhari_records").update(payload).eq("id",d.entryId||p.entryId);const {error}=await q;if(error)throw error;}return {success:true,data:recalcUdhari(await all(client,"udhari_records"))};}
  if(action==="getExpenseData"){const [e,b]=await Promise.all([all(client,"expenses"),client.from("expense_budgets").select("*")]);if(b.error)throw b.error;return {success:true,headers:EXPENSE_HEADERS,data:expenseData(e,b.data||[]),budgets:(b.data||[]).map(x=>[x.month,x.category,n(x.monthly_budget),n(x.warning_limit),x.notes,x.active])};}
  if(["saveExpense","updateExpense","deleteExpense","saveExpenseBudget"].includes(action)){if(action==="saveExpenseBudget"){const d=parseJson(p.data),{error}=await client.from("expense_budgets").upsert({created_by:user.uid,month:s(d.month),category:s(d.category),monthly_budget:n(d.budget),warning_limit:n(d.warningLimit)||80,notes:s(d.notes),active:d.active!==false},{onConflict:"created_by,month,category"});if(error)throw error;}else if(action==="deleteExpense"){const {error}=await client.from("expenses").delete().eq("id",p.expenseId);if(error)throw error;}else{const d=parseJson(p.data),payload={entry_date:s(d.date),category:s(d.category),sub_category:s(d.subCategory),description:s(d.description),amount:n(d.amount),payment_mode:s(d.paymentMode),paid_to:s(d.paidTo),reference_no:s(d.referenceNo),bill_link:s(d.billLink),expense_type:s(d.expenseType),priority:s(d.priority),added_by_email:user.email||""};const q=action==="saveExpense"?client.from("expenses").insert({...payload,id:d.expenseId||crypto.randomUUID()}):client.from("expenses").update(payload).eq("id",d.expenseId||p.expenseId);const {error}=await q;if(error)throw error;}const [e,b]=await Promise.all([all(client,"expenses"),client.from("expense_budgets").select("*")]);if(b.error)throw b.error;return {success:true,data:expenseData(e,b.data||[]),budgets:(b.data||[]).map(x=>[x.month,x.category,n(x.monthly_budget),n(x.warning_limit),x.notes,x.active])};}
  throw Error(`Unsupported action: ${action}`);
}

export function installSupabaseApiAdapter(client,user){
  if(window.__krpSupabaseAdapterInstalled)return; window.__krpSupabaseAdapterInstalled=true;
  const nativeFetch=window.fetch.bind(window);
  window.fetch=async(input,init={})=>{const url=typeof input==="string"?input:input.url;if(!url.includes(API_MARKER))return nativeFetch(input,init);try{return response(await route(client,user,paramsFrom(input,init)));}catch(error){console.error("Supabase API:",error);const transaction=["getRecords","saveRecord","updateRecord","deleteRecord"].includes(paramsFrom(input,init).action);return response(transaction?{status:"error",message:error.message}:{success:false,error:error.message});}};
  window.__krpResolveApiGate?.();
}
