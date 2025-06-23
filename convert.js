// Utility functions
const clamp = (x, min, max) => Math.min(max, Math.max(x, min));
const mod = (x, n) => ((x % n) + n) % n;

// Pixel copying strategies
const createPixelCopier = {
  nearest: (read, write) => {
    const { width, height, data } = read;
    const readIndex = (x, y) => 4 * (y * width + x);

    return (xFrom, yFrom, to) => {
      const nearest = readIndex(
        clamp(Math.round(xFrom), 0, width - 1),
        clamp(Math.round(yFrom), 0, height - 1)
      );

      write.data.set(data.subarray(nearest, nearest + 3), to);
    };
  },

  bilinear: (read, write) => {
    const { width, height, data } = read;
    const readIndex = (x, y) => 4 * (y * width + x);

    return (xFrom, yFrom, to) => {
      const xl = clamp(Math.floor(xFrom), 0, width - 1);
      const xr = clamp(Math.ceil(xFrom), 0, width - 1);
      const xf = xFrom - xl;

      const yl = clamp(Math.floor(yFrom), 0, height - 1);
      const yr = clamp(Math.ceil(yFrom), 0, height - 1);
      const yf = yFrom - yl;

      const p00 = readIndex(xl, yl);
      const p10 = readIndex(xr, yl);
      const p01 = readIndex(xl, yr);
      const p11 = readIndex(xr, yr);

      for (let channel = 0; channel < 3; channel++) {
        const p0 = data[p00 + channel] * (1 - xf) + data[p10 + channel] * xf;
        const p1 = data[p01 + channel] * (1 - xf) + data[p11 + channel] * xf;
        write.data[to + channel] = Math.ceil(p0 * (1 - yf) + p1 * yf);
      }
    };
  },

  bicubic: (read, write) => {
    const b = -0.5;
    const kernel = x => {
      x = Math.abs(x);
      const x2 = x * x;
      const x3 = x * x2;
      return x <= 1 
        ? (b + 2) * x3 - (b + 3) * x2 + 1 
        : b * x3 - 5 * b * x2 + 8 * b * x - 4 * b;
    };

    return createKernelResampler(read, write, 2, kernel);
  },

  lanczos: (read, write) => {
    const filterSize = 5;
    const kernel = x => {
      if (x === 0) return 1;
      const xp = Math.PI * x;
      return filterSize * Math.sin(xp) * Math.sin(xp / filterSize) / (xp * xp);
    };

    return createKernelResampler(read, write, filterSize, kernel);
  }
};

// Kernel-based resampling
function createKernelResampler(read, write, filterSize, kernel) {
  const { width, height, data } = read;
  const readIndex = (x, y) => 4 * (y * width + x);
  const twoFilterSize = 2 * filterSize;
  const xMax = width - 1;
  const yMax = height - 1;
  const xKernel = new Float32Array(twoFilterSize);
  const yKernel = new Float32Array(twoFilterSize);

  return (xFrom, yFrom, to) => {
    const xl = Math.floor(xFrom);
    const yl = Math.floor(yFrom);
    const xStart = xl - filterSize + 1;
    const yStart = yl - filterSize + 1;

    // Precompute kernel values
    for (let i = 0; i < twoFilterSize; i++) {
      xKernel[i] = kernel(xFrom - (xStart + i));
      yKernel[i] = kernel(yFrom - (yStart + i));
    }

    // Normalize kernels
    const xSum = xKernel.reduce((sum, val) => sum + val, 0);
    const ySum = yKernel.reduce((sum, val) => sum + val, 0);
    for (let i = 0; i < twoFilterSize; i++) {
      xKernel[i] /= xSum;
      yKernel[i] /= ySum;
    }

    for (let channel = 0; channel < 3; channel++) {
      let q = 0;

      for (let i = 0; i < twoFilterSize; i++) {
        const y = clamp(yStart + i, 0, yMax);
        let p = 0;
        
        for (let j = 0; j < twoFilterSize; j++) {
          const x = clamp(xStart + j, 0, xMax);
          const index = readIndex(x, y);
          p += data[index + channel] * xKernel[j];
        }
        
        q += p * yKernel[i];
      }

      write.data[to + channel] = Math.round(q);
    }
  };
}

// Cube face orientations
const faceOrientations = {
  pz: (out, x, y) => {
    out.x = -1;
    out.y = -x;
    out.z = -y;
  },
  nz: (out, x, y) => {
    out.x = 1;
    out.y = x;
    out.z = -y;
  },
  px: (out, x, y) => {
    out.x = x;
    out.y = -1;
    out.z = -y;
  },
  nx: (out, x, y) => {
    out.x = -x;
    out.y = 1;
    out.z = -y;
  },
  py: (out, x, y) => {
    out.x = -y;
    out.y = -x;
    out.z = 1;
  },
  ny: (out, x, y) => {
    out.x = y;
    out.y = -x;
    out.z = -1;
  }
};

// Main rendering function
function renderFace({ data: readData, face, rotation, interpolation = 'lanczos', maxWidth = Infinity }) {
  const faceWidth = Math.min(maxWidth, Math.floor(readData.width / 4));
  const faceHeight = faceWidth;
  const writeData = new ImageData(faceWidth, faceHeight);
  const orientation = faceOrientations[face];
  const cube = { x: 0, y: 0, z: 0 };

  // Select the appropriate pixel copying strategy
  const copyPixel = createPixelCopier[interpolation]?.(readData, writeData) || 
                   createPixelCopier.nearest(readData, writeData);

  // Precompute constants
  const widthRatio = 2 / faceWidth;
  const heightRatio = 2 / faceHeight;
  const lonFactor = readData.width / (2 * Math.PI);
  const latFactor = readData.height / Math.PI;

  // Render each pixel
  for (let y = 0; y < faceHeight; y++) {
    for (let x = 0; x < faceWidth; x++) {
      const to = 4 * (y * faceWidth + x);
      
      // Set alpha channel
      writeData.data[to + 3] = 255;

      // Calculate cube face position
      orientation(
        cube,
        widthRatio * (x + 0.5) - 1,
        heightRatio * (y + 0.5) - 1
      );

      // Convert to spherical coordinates
      const r = Math.sqrt(cube.x * cube.x + cube.y * cube.y + cube.z * cube.z);
      const lon = mod(Math.atan2(cube.y, cube.x) + rotation, 2 * Math.PI);
      const lat = Math.acos(cube.z / r);

      // Sample and copy pixel
      copyPixel(
        lon * lonFactor - 0.5,
        lat * latFactor - 0.5,
        to
      );
    }
  }

  // Send result back with additional info for preview/final distinction
  postMessage({
    data: writeData,
    width: faceWidth,
    height: faceHeight,
    isPreview: maxWidth !== Infinity
  }, [writeData.data.buffer]);
}

// Worker message handler
onmessage = function({ data }) {
  try {
    renderFace(data);
  } catch (error) {
    postMessage({ error: error.message });
  }
};
