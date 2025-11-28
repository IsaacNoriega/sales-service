const AWS = require('aws-sdk');

const cloudwatch = new AWS.CloudWatch({ region: process.env.AWS_REGION || 'us-east-1' });

const ENV = process.env.NODE_ENV || "LOCAL";

const logMetric = async (metricName, value, unit, dimensions = {}) => {
    
    console.log(`[METRICA - ${ENV}] ${metricName}: ${value} ${JSON.stringify(dimensions)}`);

    try {

        const awsDimensions = [
            { Name: 'Environment', Value: ENV }, 
            ...Object.keys(dimensions).map(key => ({ Name: key, Value: dimensions[key] }))
        ];

        const params = {
            MetricData: [
                {
                    MetricName: metricName,
                    Dimensions: awsDimensions,
                    Unit: unit,
                    Value: value
                },
            ],
            Namespace: 'ExamenFinal/App' 
        };

        await cloudwatch.putMetricData(params).promise();
        
    } catch (error) {
        console.error("No se pudo enviar métrica a AWS:", error.message);
    }
};

module.exports = { logMetric };