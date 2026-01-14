const express = require('express');

const app = express();
const port = 3001;

const TRINO_URL = 'http://trino:8080';
const TRINO_USER = 'trino-query-ui';

app.use(express.static('public'));
app.use(express.json());

async function executeTrinoQuery(query) {
  // Submit query to Trino
  const submitResponse = await fetch(`${TRINO_URL}/v1/statement`, {
    method: 'POST',
    headers: {
      'X-Trino-User': TRINO_USER,
      'Content-Type': 'text/plain',
    },
    body: query,
  });

  if (!submitResponse.ok) {
    const errorText = await submitResponse.text();
    throw new Error(`Trino query submission failed: ${submitResponse.status} - ${errorText}`);
  }

  let result = await submitResponse.json();
  let columns = result.columns || [];
  let allData = result.data || [];

  // Follow nextUri to get all results
  while (result.nextUri) {
    const nextResponse = await fetch(result.nextUri, {
      method: 'GET',
      headers: {
        'X-Trino-User': TRINO_USER,
      },
    });

    if (!nextResponse.ok) {
      const errorText = await nextResponse.text();
      throw new Error(`Trino query polling failed: ${nextResponse.status} - ${errorText}`);
    }

    result = await nextResponse.json();
    
    // Check for errors in the result
    if (result.error) {
      throw new Error(result.error.message || 'Query execution failed');
    }

    // Update columns if not already set
    if (!columns.length && result.columns) {
      columns = result.columns;
    }

    // Accumulate data
    if (result.data) {
      allData = allData.concat(result.data);
    }
  }

  // Transform data into objects with column names
  const transformedData = allData.map(row => {
    const obj = {};
    columns.forEach((col, idx) => {
      obj[col.name] = row[idx];
    });
    return obj;
  });

  return {
    columns: columns.map(c => c.name),
    data: transformedData,
  };
}

app.post('/query', async (req, res) => {
  const { query } = req.body;

  if (!query) {
    return res.status(400).json({ error: 'Query is required' });
  }

  try {
    const results = await executeTrinoQuery(query);
    res.json(results);
  } catch (error) {
    console.error('Query error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Trino Query UI server listening at http://localhost:${port}`);
});
