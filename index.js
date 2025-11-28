const express = require('express');
const mongoose = require('mongoose');
const AWS = require('aws-sdk');
const PDFDocument = require('pdfkit');

const { logMetric } = require('./metrics');
require('dotenv').config();

const app = express();
app.use(express.json());


class ClientError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
        this.name = 'ClientError';
    }
}

const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;
const SNS_TOPIC_ARN = process.env.SNS_TOPIC_ARN;
const MONGO_URI = process.env.MONGO_URI;

AWS.config.update({ region: process.env.AWS_REGION || 'us-east-1' });
const s3 = new AWS.S3();
const sns = new AWS.SNS();

mongoose.connect(MONGO_URI)
    .then(() => console.log('DB Conectada'))
    .catch(err => console.error('Error DB:', err));

// Esquema de Venta
const VentaSchema = new mongoose.Schema({
    cliente: { type: mongoose.Schema.Types.ObjectId, ref: 'Cliente', required: true },
    cliente_snapshot: { nombre: String, email: String, telefono: String, rfc: String, direccion: String },
    items: [{
        producto: { type: mongoose.Schema.Types.ObjectId, ref: 'Producto', required: true },
        snapshot: { nombre: String, descripcion: String, precio: Number, categoria: String },
        cantidad: Number
    }],
    total: Number,
    pdf_url: String,
    estado: { type: String, enum: ['pagada', 'pendiente', 'cancelada'], default: 'pagada' },
    folio: { type: String, unique: true },
    fecha: { type: Date, default: Date.now }
});
const Venta = mongoose.model('Venta', VentaSchema);

// Generar y subir pdf
const generarYSubirPDF = async (ventaData, ventaId) => {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument();
        const buffers = [];
        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', async () => {
            const pdfData = Buffer.concat(buffers);
            const params = { Bucket: S3_BUCKET_NAME, Key: `notas_venta/nota_${ventaId}.pdf`, Body: pdfData, ContentType: 'application/pdf' };
            try {
                const stored = await s3.upload(params).promise();
                resolve(stored.Location);
            } catch (e) {
                reject(e);
            }
        });

        // Diseño simple del PDF
        doc.fontSize(20).text('NOTA DE VENTA', { align: 'center' });
        doc.moveDown();
        doc.fontSize(14).text(`Folio: ${ventaData.folio || ventaId}`);
        doc.text(`Cliente: ${ventaData.cliente_snapshot.nombre}`);
        doc.text(`RFC: ${ventaData.cliente_snapshot.rfc || 'Generico'}`);
        doc.text(`Fecha: ${new Date().toLocaleString()}`);
        doc.moveDown();

        doc.text('--- DETALLE ---');
        ventaData.items.forEach(item => {
            const nombre = item.snapshot.nombre;
            const precio = item.snapshot.precio;
            const subtotal = precio * item.cantidad;
            doc.text(`${nombre} x${item.cantidad} - $${subtotal}`);
        });
        doc.moveDown();
        doc.fontSize(16).text(`TOTAL: $${ventaData.total}`, { align: 'right' });
        doc.end();
    });
};

// Post para crear una venta
app.post('/ventas', async (req, res) => {
    const start = Date.now();
    try {
        const { cliente, productos, metodo_pago, direccion_entrega } = req.body;

        // Validación 
        if (!cliente || !Array.isArray(productos) || productos.length === 0) {
            return res.status(400).json({ error: 'Faltan datos obligatorios: cliente y productos.' });
        }

        const clienteData = await mongoose.connection.db.collection('clientes').findOne({ _id: new mongoose.Types.ObjectId(cliente) });
        if (!clienteData) return res.status(404).json({ error: 'Cliente no encontrado.' });

        const items = [];
        let total = 0;

        for (const p of productos) {
            const prodData = await mongoose.connection.db.collection('productos').findOne({ _id: new mongoose.Types.ObjectId(p.producto) });
            if (!prodData) return res.status(404).json({ error: `Producto no encontrado: ${p.producto}` });
            if (prodData.stock < p.cantidad) return res.status(409).json({ error: `Stock insuficiente para ${prodData.nombre}` });

            items.push({
                producto: prodData._id,
                snapshot: { nombre: prodData.nombre, descripcion: prodData.descripcion, precio: prodData.precio, categoria: prodData.categoria },
                cantidad: p.cantidad
            });
            total += prodData.precio * p.cantidad;
        }

        for (const p of productos) {
            await mongoose.connection.db.collection('productos').updateOne({ _id: new mongoose.Types.ObjectId(p.producto) }, { $inc: { stock: -p.cantidad } });
        }
        const nuevaVentaId = new mongoose.Types.ObjectId();
        const folio = `VENTA-${nuevaVentaId.toString().slice(-6).toUpperCase()}`;

        const ventaSnapshot = {
            folio, cliente_snapshot: { nombre: clienteData.nombre, email: clienteData.email, telefono: clienteData.telefono, rfc: clienteData.rfc || 'Generico', direccion: clienteData.direccion },
            items, total
        };

        // Generar PDF
        console.log("Generando PDF");
        const urlPDF = await generarYSubirPDF(ventaSnapshot, nuevaVentaId);

        const ventaGuardada = await Venta.create({
            _id: nuevaVentaId, cliente: clienteData._id, ...ventaSnapshot, pdf_url: urlPDF, estado: 'pagada', metodo_pago, direccion_entrega, folio
        });
        await sns.publish({ TopicArn: SNS_TOPIC_ARN, Subject: `Nueva Compra Confirmada - ${folio}`, Message: `Hola ${clienteData.nombre},\n\nDescarga tu nota:\n${urlPDF}\n\nTotal: $${total}` }).promise();

        const duration = Date.now() - start;
        await logMetric("TiempoEjecucion", duration, "Milliseconds", { Endpoint: "/ventas" });
        await logMetric("RequestCount", 1, "Count", { Status: "2xx" });

        res.status(201).json({ status: "Venta Exitosa", pdf: urlPDF, id: ventaGuardada._id, folio });

    } catch (error) {
        const duration = Date.now() - start;
        let statusCode = 500;
        let statusMetric = '5xx';
        if (error.name === 'ValidationError' || error.name === 'ClientError') {
            statusCode = error.status || 400;
            statusMetric = (statusCode >= 400 && statusCode < 500) ? '4xx' : '5xx';
        }
        if (res.headersSent) return;
        console.error(`Error ${statusCode} en venta:`, error.message);
        await logMetric("TiempoEjecucion", duration, "Milliseconds", { Endpoint: "/ventas" });
        await logMetric("RequestCount", 1, "Count", { Status: statusMetric });
        res.status(statusCode).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sales Service running on ${PORT}`));