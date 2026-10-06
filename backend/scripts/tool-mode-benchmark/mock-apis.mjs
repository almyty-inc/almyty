// The three APIs the tool-mode benchmark imports (docs/design/code-mode.md,
// "Benchmark"): a pet store, a shop and a helpdesk, 50+ operations between
// them. One table per API gives both its OpenAPI document (what almyty
// imports) and an in-memory server (what the generated tools call), so the
// end state a task leaves behind can be checked exactly.
import http from 'node:http'

/** The data every run starts from. Tasks are checked against it. */
export function seedState() {
  const pets = [
    { id: 1, name: 'Biscuit', status: 'available', category: 'dog', tags: ['friendly'] },
    { id: 2, name: 'Mochi', status: 'sold', category: 'cat', tags: ['indoor'] },
    { id: 3, name: 'Pepper', status: 'available', category: 'dog', tags: ['puppy'] },
    { id: 4, name: 'Juniper', status: 'pending', category: 'bird', tags: [] },
    { id: 5, name: 'Rocket', status: 'sold', category: 'dog', tags: ['senior'] },
    { id: 6, name: 'Olive', status: 'available', category: 'cat', tags: ['indoor', 'friendly'] },
    { id: 7, name: 'Captain Whiskers', status: 'available', category: 'cat', tags: ['senior'] },
    { id: 8, name: 'Nibbles', status: 'sold', category: 'rabbit', tags: [] },
  ]
  const customers = [
    { id: 'C-10', name: 'Ana Horvat', email: 'ana.horvat@example.com', tier: 'gold' },
    { id: 'C-11', name: 'Ben Okafor', email: 'ben.okafor@example.com', tier: 'standard' },
    { id: 'C-12', name: 'Chiara Rossi', email: 'chiara.rossi@example.com', tier: 'standard' },
    { id: 'C-13', name: 'Dmitri Volkov', email: 'dmitri.volkov@example.com', tier: 'gold' },
  ]
  const products = [
    { sku: 'SKU-COFFEE', name: 'Coffee beans 1kg', price: 24, stock: 37 },
    { sku: 'SKU-MUG', name: 'Enamel mug', price: 12, stock: 3 },
    { sku: 'SKU-FILTER', name: 'Paper filters', price: 5, stock: 0 },
    { sku: 'SKU-GRINDER', name: 'Hand grinder', price: 89, stock: 4 },
    { sku: 'SKU-KETTLE', name: 'Gooseneck kettle', price: 64, stock: 15 },
  ]
  const orders = [
    { id: 'O-2001', customerId: 'C-10', status: 'shipped', items: [{ sku: 'SKU-COFFEE', qty: 2 }], total: 48 },
    { id: 'O-2002', customerId: 'C-12', status: 'pending', items: [{ sku: 'SKU-MUG', qty: 1 }], total: 12 },
    { id: 'O-2003', customerId: 'C-13', status: 'delivered', items: [{ sku: 'SKU-KETTLE', qty: 1 }], total: 64 },
    { id: 'O-2004', customerId: 'C-12', status: 'pending', items: [{ sku: 'SKU-FILTER', qty: 4 }], total: 20 },
    { id: 'O-2005', customerId: 'C-12', status: 'shipped', items: [{ sku: 'SKU-COFFEE', qty: 1 }], total: 24 },
    { id: 'O-2006', customerId: 'C-11', status: 'pending', items: [{ sku: 'SKU-GRINDER', qty: 1 }], total: 89 },
  ]
  const staff = [
    { id: 'S-1', name: 'Dana Kim', email: 'dana@helpdesk.example' },
    { id: 'S-2', name: 'Eli Brandt', email: 'eli@helpdesk.example' },
  ]
  const tickets = [
    { id: 'T-1001', subject: 'Cannot log in', status: 'open', priority: 'high', assigneeId: 'S-1', tags: ['login'] },
    { id: 'T-1002', subject: 'WIN A FREE CRUISE', status: 'open', priority: 'low', assigneeId: null, tags: ['spam'] },
    { id: 'T-1003', subject: 'Invoice is wrong', status: 'open', priority: 'normal', assigneeId: 'S-2', tags: ['billing'] },
    { id: 'T-1004', subject: 'Feature request: dark mode', status: 'pending', priority: 'low', assigneeId: 'S-1', tags: ['feature'] },
    { id: 'T-1005', subject: 'Cheap watches!!!', status: 'open', priority: 'low', assigneeId: null, tags: ['spam'] },
    { id: 'T-1006', subject: 'App crashes on start', status: 'open', priority: 'urgent', assigneeId: 'S-1', tags: ['bug'] },
    { id: 'T-1007', subject: 'Refund not received', status: 'closed', priority: 'normal', assigneeId: 'S-2', tags: ['billing'] },
    { id: 'T-1008', subject: 'Crypto opportunity', status: 'open', priority: 'low', assigneeId: 'S-2', tags: ['spam'] },
  ]
  return {
    pets,
    petOrders: [{ id: 1, petId: 2, quantity: 1, status: 'delivered' }],
    users: [{ username: 'frontdesk', firstName: 'Front', lastName: 'Desk', email: 'frontdesk@pets.example' }],
    customers,
    products,
    orders,
    refunds: [],
    coupons: [{ code: 'WELCOME10', percent: 10 }],
    shipments: [{ orderId: 'O-2001', carrier: 'DHL', tracking: 'DHL-883120' }],
    staff,
    tickets,
    comments: [{ ticketId: 'T-1001', author: 'S-1', body: 'Asked for a screenshot.' }],
  }
}

const S = (type, description, extra = {}) => ({ type, description, ...extra })
const notFound = (what) => [404, { error: `${what} not found` }]
const pick = (list, key, value) => list.find((x) => String(x[key]) === String(value))

/**
 * The routes. `args` merges path, query and body parameters, whichever way
 * the generated tool sends them.
 */
export const ROUTES = [
  // ── Pet store (the Swagger Petstore's operations) ─────────────────────
  { api: 'pets', method: 'post', path: '/pet', operationId: 'addPet', summary: 'Add a new pet to the store',
    body: { name: S('string', 'Pet name'), category: S('string', 'Kind of animal'), status: S('string', 'Pet status', { enum: ['available', 'pending', 'sold'] }) }, required: ['name'],
    handler: (st, a) => { const pet = { id: Math.max(...st.pets.map((p) => p.id)) + 1, tags: [], status: 'available', ...pick3(a, ['name', 'category', 'status']) }; st.pets.push(pet); return [200, pet] } },
  { api: 'pets', method: 'put', path: '/pet', operationId: 'updatePet', summary: 'Update an existing pet',
    body: { id: S('integer', 'Pet id'), name: S('string', 'Pet name'), status: S('string', 'Pet status', { enum: ['available', 'pending', 'sold'] }) }, required: ['id'],
    handler: (st, a) => { const p = pick(st.pets, 'id', a.id); if (!p) return notFound('Pet'); Object.assign(p, pick3(a, ['name', 'status', 'category'])); return [200, p] } },
  { api: 'pets', method: 'get', path: '/pet/findByStatus', operationId: 'findPetsByStatus', summary: 'Finds pets by status',
    params: [{ name: 'status', in: 'query', schema: S('string', 'Status to filter by', { enum: ['available', 'pending', 'sold'] }), required: true }],
    handler: (st, a) => [200, st.pets.filter((p) => p.status === a.status)] },
  { api: 'pets', method: 'get', path: '/pet/findByTags', operationId: 'findPetsByTags', summary: 'Finds pets by tags',
    params: [{ name: 'tags', in: 'query', schema: S('string', 'Comma-separated tags'), required: true }],
    handler: (st, a) => { const t = String(a.tags).split(',').map((x) => x.trim()); return [200, st.pets.filter((p) => p.tags.some((x) => t.includes(x)))] } },
  { api: 'pets', method: 'get', path: '/pet/{petId}', operationId: 'getPetById', summary: 'Find pet by ID',
    params: [{ name: 'petId', in: 'path', schema: S('integer', 'ID of pet to return'), required: true }],
    handler: (st, a) => pick(st.pets, 'id', a.petId) ? [200, pick(st.pets, 'id', a.petId)] : notFound('Pet') },
  { api: 'pets', method: 'post', path: '/pet/{petId}', operationId: 'updatePetWithForm', summary: 'Updates a pet in the store with form data',
    params: [{ name: 'petId', in: 'path', schema: S('integer', 'ID of pet to update'), required: true },
      { name: 'name', in: 'query', schema: S('string', 'New name') }, { name: 'status', in: 'query', schema: S('string', 'New status', { enum: ['available', 'pending', 'sold'] }) }],
    handler: (st, a) => { const p = pick(st.pets, 'id', a.petId); if (!p) return notFound('Pet'); Object.assign(p, pick3(a, ['name', 'status'])); return [200, p] } },
  { api: 'pets', method: 'delete', path: '/pet/{petId}', operationId: 'deletePet', summary: 'Deletes a pet',
    params: [{ name: 'petId', in: 'path', schema: S('integer', 'Pet id to delete'), required: true }],
    handler: (st, a) => { const i = st.pets.findIndex((p) => String(p.id) === String(a.petId)); if (i < 0) return notFound('Pet'); st.pets.splice(i, 1); return [200, { deleted: true }] } },
  { api: 'pets', method: 'post', path: '/pet/{petId}/uploadImage', operationId: 'uploadFile', summary: 'Uploads an image',
    params: [{ name: 'petId', in: 'path', schema: S('integer', 'ID of pet'), required: true }, { name: 'additionalMetadata', in: 'query', schema: S('string', 'Metadata') }],
    handler: (st, a) => pick(st.pets, 'id', a.petId) ? [200, { code: 200, message: 'uploaded' }] : notFound('Pet') },
  { api: 'pets', method: 'get', path: '/store/inventory', operationId: 'getInventory', summary: 'Returns pet inventories by status',
    handler: (st) => [200, st.pets.reduce((m, p) => ({ ...m, [p.status]: (m[p.status] ?? 0) + 1 }), {})] },
  { api: 'pets', method: 'post', path: '/store/order', operationId: 'placeOrder', summary: 'Place an order for a pet',
    body: { petId: S('integer', 'Pet id'), quantity: S('integer', 'Quantity') }, required: ['petId'],
    handler: (st, a) => { const o = { id: st.petOrders.length + 1, petId: Number(a.petId), quantity: Number(a.quantity ?? 1), status: 'placed' }; st.petOrders.push(o); return [200, o] } },
  { api: 'pets', method: 'get', path: '/store/order/{orderId}', operationId: 'getOrderById', summary: 'Find purchase order by ID',
    params: [{ name: 'orderId', in: 'path', schema: S('integer', 'ID of the order'), required: true }],
    handler: (st, a) => pick(st.petOrders, 'id', a.orderId) ? [200, pick(st.petOrders, 'id', a.orderId)] : notFound('Order') },
  { api: 'pets', method: 'delete', path: '/store/order/{orderId}', operationId: 'deleteOrder', summary: 'Delete purchase order by ID',
    params: [{ name: 'orderId', in: 'path', schema: S('integer', 'ID of the order'), required: true }],
    handler: (st, a) => { const i = st.petOrders.findIndex((o) => String(o.id) === String(a.orderId)); if (i < 0) return notFound('Order'); st.petOrders.splice(i, 1); return [200, { deleted: true }] } },
  { api: 'pets', method: 'post', path: '/user', operationId: 'createUser', summary: 'Create user',
    body: { username: S('string', 'Username'), firstName: S('string', 'First name'), lastName: S('string', 'Last name'), email: S('string', 'Email') }, required: ['username'],
    handler: (st, a) => { const u = pick3(a, ['username', 'firstName', 'lastName', 'email']); st.users.push(u); return [200, u] } },
  { api: 'pets', method: 'post', path: '/user/createWithList', operationId: 'createUsersWithListInput', summary: 'Creates list of users with given input array',
    body: { users: { type: 'array', description: 'Users', items: { type: 'object', properties: { username: S('string', 'Username'), email: S('string', 'Email') } } } }, required: ['users'],
    handler: (st, a) => { for (const u of a.users ?? []) st.users.push(u); return [200, { created: (a.users ?? []).length }] } },
  { api: 'pets', method: 'get', path: '/user/login', operationId: 'loginUser', summary: 'Logs user into the system',
    params: [{ name: 'username', in: 'query', schema: S('string', 'User name'), required: true }, { name: 'password', in: 'query', schema: S('string', 'Password'), required: true }],
    handler: () => [200, { session: 'session-1' }] },
  { api: 'pets', method: 'get', path: '/user/logout', operationId: 'logoutUser', summary: 'Logs out current logged in user session',
    handler: () => [200, { ok: true }] },
  { api: 'pets', method: 'get', path: '/user/{username}', operationId: 'getUserByName', summary: 'Get user by user name',
    params: [{ name: 'username', in: 'path', schema: S('string', 'User name'), required: true }],
    handler: (st, a) => pick(st.users, 'username', a.username) ? [200, pick(st.users, 'username', a.username)] : notFound('User') },
  { api: 'pets', method: 'put', path: '/user/{username}', operationId: 'updateUser', summary: 'Update user',
    params: [{ name: 'username', in: 'path', schema: S('string', 'User name'), required: true }],
    body: { firstName: S('string', 'First name'), lastName: S('string', 'Last name'), email: S('string', 'Email') },
    handler: (st, a) => { const u = pick(st.users, 'username', a.username); if (!u) return notFound('User'); Object.assign(u, pick3(a, ['firstName', 'lastName', 'email'])); return [200, u] } },
  { api: 'pets', method: 'delete', path: '/user/{username}', operationId: 'deleteUser', summary: 'Delete user',
    params: [{ name: 'username', in: 'path', schema: S('string', 'User name'), required: true }],
    handler: (st, a) => { const i = st.users.findIndex((u) => u.username === a.username); if (i < 0) return notFound('User'); st.users.splice(i, 1); return [200, { deleted: true }] } },

  // ── Shop ──────────────────────────────────────────────────────────────
  { api: 'shop', method: 'get', path: '/customers', operationId: 'listCustomers', summary: 'List customers',
    params: [{ name: 'tier', in: 'query', schema: S('string', 'Filter by tier', { enum: ['standard', 'gold'] }) }],
    handler: (st, a) => [200, st.customers.filter((c) => !a.tier || c.tier === a.tier)] },
  { api: 'shop', method: 'get', path: '/customers/{customerId}', operationId: 'getCustomer', summary: 'Get a customer by id',
    params: [{ name: 'customerId', in: 'path', schema: S('string', 'Customer id, like C-10'), required: true }],
    handler: (st, a) => pick(st.customers, 'id', a.customerId) ? [200, pick(st.customers, 'id', a.customerId)] : notFound('Customer') },
  { api: 'shop', method: 'post', path: '/customers', operationId: 'createCustomer', summary: 'Create a customer',
    body: { name: S('string', 'Full name'), email: S('string', 'Email') }, required: ['name', 'email'],
    handler: (st, a) => { const c = { id: `C-${10 + st.customers.length}`, tier: 'standard', ...pick3(a, ['name', 'email']) }; st.customers.push(c); return [201, c] } },
  { api: 'shop', method: 'patch', path: '/customers/{customerId}', operationId: 'updateCustomer', summary: 'Update a customer',
    params: [{ name: 'customerId', in: 'path', schema: S('string', 'Customer id'), required: true }],
    body: { email: S('string', 'Email'), tier: S('string', 'Tier', { enum: ['standard', 'gold'] }) },
    handler: (st, a) => { const c = pick(st.customers, 'id', a.customerId); if (!c) return notFound('Customer'); Object.assign(c, pick3(a, ['email', 'tier', 'name'])); return [200, c] } },
  { api: 'shop', method: 'get', path: '/orders', operationId: 'listOrders', summary: 'List orders, optionally by customer or status',
    params: [{ name: 'customerId', in: 'query', schema: S('string', 'Customer id') }, { name: 'status', in: 'query', schema: S('string', 'Order status', { enum: ['pending', 'shipped', 'delivered', 'cancelled'] }) }],
    handler: (st, a) => [200, st.orders.filter((o) => (!a.customerId || o.customerId === a.customerId) && (!a.status || o.status === a.status))] },
  { api: 'shop', method: 'get', path: '/orders/{orderId}', operationId: 'getOrder', summary: 'Get an order by id',
    params: [{ name: 'orderId', in: 'path', schema: S('string', 'Order id, like O-2001'), required: true }],
    handler: (st, a) => pick(st.orders, 'id', a.orderId) ? [200, pick(st.orders, 'id', a.orderId)] : notFound('Order') },
  { api: 'shop', method: 'post', path: '/orders', operationId: 'createOrder', summary: 'Create an order',
    body: { customerId: S('string', 'Customer id'), sku: S('string', 'Product SKU'), qty: S('integer', 'Quantity') }, required: ['customerId', 'sku'],
    handler: (st, a) => { const p = pick(st.products, 'sku', a.sku); if (!p) return notFound('Product'); const o = { id: `O-${2001 + st.orders.length}`, customerId: a.customerId, status: 'pending', items: [{ sku: a.sku, qty: Number(a.qty ?? 1) }], total: p.price * Number(a.qty ?? 1) }; st.orders.push(o); return [201, o] } },
  { api: 'shop', method: 'post', path: '/orders/{orderId}/cancel', operationId: 'cancelOrder', summary: 'Cancel an order that has not shipped',
    params: [{ name: 'orderId', in: 'path', schema: S('string', 'Order id'), required: true }],
    handler: (st, a) => { const o = pick(st.orders, 'id', a.orderId); if (!o) return notFound('Order'); if (o.status !== 'pending') return [409, { error: `Order is ${o.status}` }]; o.status = 'cancelled'; return [200, o] } },
  { api: 'shop', method: 'get', path: '/orders/{orderId}/shipment', operationId: 'getShipment', summary: 'Get the shipment of an order',
    params: [{ name: 'orderId', in: 'path', schema: S('string', 'Order id'), required: true }],
    handler: (st, a) => pick(st.shipments, 'orderId', a.orderId) ? [200, pick(st.shipments, 'orderId', a.orderId)] : notFound('Shipment') },
  { api: 'shop', method: 'post', path: '/orders/{orderId}/shipment', operationId: 'createShipment', summary: 'Ship an order',
    params: [{ name: 'orderId', in: 'path', schema: S('string', 'Order id'), required: true }], body: { carrier: S('string', 'Carrier') },
    handler: (st, a) => { const o = pick(st.orders, 'id', a.orderId); if (!o) return notFound('Order'); o.status = 'shipped'; const s = { orderId: o.id, carrier: a.carrier ?? 'DHL', tracking: `T-${Date.now()}` }; st.shipments.push(s); return [201, s] } },
  { api: 'shop', method: 'get', path: '/products', operationId: 'listProducts', summary: 'List products with price and stock',
    handler: (st) => [200, st.products] },
  { api: 'shop', method: 'get', path: '/products/{sku}', operationId: 'getProduct', summary: 'Get a product by SKU',
    params: [{ name: 'sku', in: 'path', schema: S('string', 'Product SKU, like SKU-COFFEE'), required: true }],
    handler: (st, a) => pick(st.products, 'sku', a.sku) ? [200, pick(st.products, 'sku', a.sku)] : notFound('Product') },
  { api: 'shop', method: 'put', path: '/products/{sku}/stock', operationId: 'setProductStock', summary: 'Set the stock level of a product',
    params: [{ name: 'sku', in: 'path', schema: S('string', 'Product SKU'), required: true }], body: { stock: S('integer', 'Units in stock') }, required: ['stock'],
    handler: (st, a) => { const p = pick(st.products, 'sku', a.sku); if (!p) return notFound('Product'); p.stock = Number(a.stock); return [200, p] } },
  { api: 'shop', method: 'patch', path: '/products/{sku}', operationId: 'updateProduct', summary: 'Update a product name or price',
    params: [{ name: 'sku', in: 'path', schema: S('string', 'Product SKU'), required: true }], body: { name: S('string', 'Name'), price: S('number', 'Price') },
    handler: (st, a) => { const p = pick(st.products, 'sku', a.sku); if (!p) return notFound('Product'); Object.assign(p, pick3(a, ['name', 'price'])); return [200, p] } },
  { api: 'shop', method: 'post', path: '/refunds', operationId: 'createRefund', summary: 'Refund an order, fully or in part',
    body: { orderId: S('string', 'Order id'), amount: S('number', 'Amount to refund') }, required: ['orderId', 'amount'],
    handler: (st, a) => { if (!pick(st.orders, 'id', a.orderId)) return notFound('Order'); const r = { id: `R-${st.refunds.length + 1}`, orderId: a.orderId, amount: Number(a.amount) }; st.refunds.push(r); return [201, r] } },
  { api: 'shop', method: 'get', path: '/refunds', operationId: 'listRefunds', summary: 'List refunds', handler: (st) => [200, st.refunds] },
  { api: 'shop', method: 'get', path: '/coupons', operationId: 'listCoupons', summary: 'List coupon codes', handler: (st) => [200, st.coupons] },
  { api: 'shop', method: 'post', path: '/coupons', operationId: 'createCoupon', summary: 'Create a coupon code',
    body: { code: S('string', 'Code'), percent: S('integer', 'Discount percent') }, required: ['code', 'percent'],
    handler: (st, a) => { const c = { code: a.code, percent: Number(a.percent) }; st.coupons.push(c); return [201, c] } },
  { api: 'shop', method: 'delete', path: '/coupons/{code}', operationId: 'deleteCoupon', summary: 'Delete a coupon code',
    params: [{ name: 'code', in: 'path', schema: S('string', 'Code'), required: true }],
    handler: (st, a) => { const i = st.coupons.findIndex((c) => c.code === a.code); if (i < 0) return notFound('Coupon'); st.coupons.splice(i, 1); return [200, { deleted: true }] } },

  // ── Helpdesk ──────────────────────────────────────────────────────────
  { api: 'helpdesk', method: 'get', path: '/tickets', operationId: 'listTickets', summary: 'List tickets, filtered by status, assignee or tag',
    params: [{ name: 'status', in: 'query', schema: S('string', 'Status', { enum: ['open', 'pending', 'closed'] }) },
      { name: 'assigneeId', in: 'query', schema: S('string', 'Staff id, like S-1') }, { name: 'tag', in: 'query', schema: S('string', 'Tag') }],
    handler: (st, a) => [200, st.tickets.filter((t) => (!a.status || t.status === a.status) && (!a.assigneeId || t.assigneeId === a.assigneeId) && (!a.tag || t.tags.includes(a.tag)))] },
  { api: 'helpdesk', method: 'get', path: '/tickets/search', operationId: 'searchTickets', summary: 'Search tickets by text in the subject',
    params: [{ name: 'q', in: 'query', schema: S('string', 'Text to look for'), required: true }],
    handler: (st, a) => [200, st.tickets.filter((t) => t.subject.toLowerCase().includes(String(a.q ?? '').toLowerCase()))] },
  { api: 'helpdesk', method: 'get', path: '/tickets/{ticketId}', operationId: 'getTicket', summary: 'Get a ticket by id',
    params: [{ name: 'ticketId', in: 'path', schema: S('string', 'Ticket id, like T-1001'), required: true }],
    handler: (st, a) => pick(st.tickets, 'id', a.ticketId) ? [200, pick(st.tickets, 'id', a.ticketId)] : notFound('Ticket') },
  { api: 'helpdesk', method: 'post', path: '/tickets', operationId: 'createTicket', summary: 'Open a ticket',
    body: { subject: S('string', 'Subject'), priority: S('string', 'Priority', { enum: ['low', 'normal', 'high', 'urgent'] }) }, required: ['subject'],
    handler: (st, a) => { const t = { id: `T-${1001 + st.tickets.length}`, status: 'open', priority: a.priority ?? 'normal', assigneeId: null, tags: [], subject: a.subject }; st.tickets.push(t); return [201, t] } },
  { api: 'helpdesk', method: 'patch', path: '/tickets/{ticketId}', operationId: 'updateTicket', summary: 'Change a ticket: status, priority or assignee',
    params: [{ name: 'ticketId', in: 'path', schema: S('string', 'Ticket id'), required: true }],
    body: { status: S('string', 'Status', { enum: ['open', 'pending', 'closed'] }), priority: S('string', 'Priority', { enum: ['low', 'normal', 'high', 'urgent'] }), assigneeId: S('string', 'Staff id') },
    handler: (st, a) => { const t = pick(st.tickets, 'id', a.ticketId); if (!t) return notFound('Ticket'); Object.assign(t, pick3(a, ['status', 'priority', 'assigneeId'])); return [200, t] } },
  { api: 'helpdesk', method: 'post', path: '/tickets/{ticketId}/close', operationId: 'closeTicket', summary: 'Close a ticket',
    params: [{ name: 'ticketId', in: 'path', schema: S('string', 'Ticket id'), required: true }],
    handler: (st, a) => { const t = pick(st.tickets, 'id', a.ticketId); if (!t) return notFound('Ticket'); t.status = 'closed'; return [200, t] } },
  { api: 'helpdesk', method: 'delete', path: '/tickets/{ticketId}', operationId: 'deleteTicket', summary: 'Delete a ticket for good',
    params: [{ name: 'ticketId', in: 'path', schema: S('string', 'Ticket id'), required: true }],
    handler: (st, a) => { const i = st.tickets.findIndex((t) => t.id === a.ticketId); if (i < 0) return notFound('Ticket'); st.tickets.splice(i, 1); return [200, { deleted: true }] } },
  { api: 'helpdesk', method: 'get', path: '/tickets/{ticketId}/comments', operationId: 'listComments', summary: 'List the comments on a ticket',
    params: [{ name: 'ticketId', in: 'path', schema: S('string', 'Ticket id'), required: true }],
    handler: (st, a) => [200, st.comments.filter((c) => c.ticketId === a.ticketId)] },
  { api: 'helpdesk', method: 'post', path: '/tickets/{ticketId}/comments', operationId: 'addComment', summary: 'Add a comment to a ticket',
    params: [{ name: 'ticketId', in: 'path', schema: S('string', 'Ticket id'), required: true }], body: { body: S('string', 'Comment text') }, required: ['body'],
    handler: (st, a) => { if (!pick(st.tickets, 'id', a.ticketId)) return notFound('Ticket'); const c = { ticketId: a.ticketId, author: 'api', body: a.body }; st.comments.push(c); return [201, c] } },
  { api: 'helpdesk', method: 'post', path: '/tickets/{ticketId}/tags', operationId: 'addTag', summary: 'Tag a ticket',
    params: [{ name: 'ticketId', in: 'path', schema: S('string', 'Ticket id'), required: true }], body: { tag: S('string', 'Tag') }, required: ['tag'],
    handler: (st, a) => { const t = pick(st.tickets, 'id', a.ticketId); if (!t) return notFound('Ticket'); if (!t.tags.includes(a.tag)) t.tags.push(a.tag); return [200, t] } },
  { api: 'helpdesk', method: 'delete', path: '/tickets/{ticketId}/tags/{tag}', operationId: 'removeTag', summary: 'Remove a tag from a ticket',
    params: [{ name: 'ticketId', in: 'path', schema: S('string', 'Ticket id'), required: true }, { name: 'tag', in: 'path', schema: S('string', 'Tag'), required: true }],
    handler: (st, a) => { const t = pick(st.tickets, 'id', a.ticketId); if (!t) return notFound('Ticket'); t.tags = t.tags.filter((x) => x !== a.tag); return [200, t] } },
  { api: 'helpdesk', method: 'get', path: '/tags', operationId: 'listTags', summary: 'List every tag in use',
    handler: (st) => [200, [...new Set(st.tickets.flatMap((t) => t.tags))].sort()] },
  { api: 'helpdesk', method: 'get', path: '/staff', operationId: 'listStaff', summary: 'List support staff', handler: (st) => [200, st.staff] },
  { api: 'helpdesk', method: 'get', path: '/staff/{staffId}', operationId: 'getStaff', summary: 'Get a staff member',
    params: [{ name: 'staffId', in: 'path', schema: S('string', 'Staff id'), required: true }],
    handler: (st, a) => pick(st.staff, 'id', a.staffId) ? [200, pick(st.staff, 'id', a.staffId)] : notFound('Staff member') },
  { api: 'helpdesk', method: 'get', path: '/sla', operationId: 'getSlaPolicy', summary: 'The response-time targets per priority',
    handler: () => [200, { urgent: '1h', high: '4h', normal: '1d', low: '3d' }] },
]

function pick3(a, keys) {
  return Object.fromEntries(keys.filter((k) => a[k] !== undefined && a[k] !== null).map((k) => [k, a[k]]))
}

export const API_TITLES = { pets: 'Pet Store', shop: 'Coffee Shop', helpdesk: 'Helpdesk' }

/** The OpenAPI 3 document of one API, served from `baseUrl`. */
export function openApiDocument(api, baseUrl) {
  const paths = {}
  for (const r of ROUTES.filter((x) => x.api === api)) {
    const op = { operationId: r.operationId, summary: r.summary, tags: [api], responses: { 200: { description: 'OK' } } }
    if (r.params?.length) op.parameters = r.params
    if (r.body) {
      op.requestBody = {
        required: !!r.required?.length,
        content: { 'application/json': { schema: { type: 'object', properties: r.body, ...(r.required ? { required: r.required } : {}) } } },
      }
    }
    paths[r.path] = { ...(paths[r.path] ?? {}), [r.method]: op }
  }
  return { openapi: '3.0.3', info: { title: API_TITLES[api], version: '1.0.0' }, servers: [{ url: `${baseUrl}/${api}` }], paths }
}

const compile = (path) => new RegExp('^' + path.replace(/\{(\w+)\}/g, '(?<$1>[^/]+)') + '$')

/** The in-memory server. `state` is reset with reset(); every call is logged in `calls`. */
export async function startMockServer(port = 0) {
  const server = { state: seedState(), calls: [] }
  const routes = ROUTES.map((r) => ({ ...r, re: compile(r.path) }))
  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const [, api, ...rest] = url.pathname.split('/')
    const path = '/' + rest.join('/')
    let body = {}
    const chunks = []
    for await (const c of req) chunks.push(c)
    if (chunks.length) {
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { body = {} }
    }
    // Static paths first (/pet/findByStatus before /pet/{petId}).
    const candidates = routes.filter((r) => r.api === api && r.method === req.method.toLowerCase())
    const route = candidates.find((r) => !r.path.includes('{') && r.re.test(path)) ?? candidates.find((r) => r.re.test(path))
    let status = 404
    let out = { error: `no route ${req.method} ${url.pathname}` }
    if (route) {
      const args = { ...(body && typeof body === 'object' && !Array.isArray(body) ? body : {}), ...Object.fromEntries(url.searchParams), ...route.re.exec(path).groups }
      ;[status, out] = route.handler(server.state, args)
      server.calls.push({ operationId: route.operationId, method: route.method, args, status })
    }
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(out))
  })
  await new Promise((resolve) => httpServer.listen(port, '127.0.0.1', resolve))
  server.port = httpServer.address().port
  server.baseUrl = `http://127.0.0.1:${server.port}`
  server.reset = () => { server.state = seedState(); server.calls = [] }
  server.close = () => new Promise((resolve) => httpServer.close(resolve))
  return server
}
