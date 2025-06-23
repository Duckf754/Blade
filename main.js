const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });

class RadioInput {
  constructor(name, onChange) {
    this.inputs = Array.from(document.querySelectorAll(`input[name="${name}"]`));
    this.inputs.forEach(input => {
      input.addEventListener('change', () => onChange(this.value));
    });
  }

  get value() {
    const checkedInput = this.inputs.find(input => input.checked);
    return checkedInput ? checkedInput.value : null;
  }
}

class Input {
  constructor(id, onChange) {
    this.input = document.getElementById(id);
    if (!this.input) throw new Error(`Element with ID ${id} not found`);
    
    this.valueAttrib = this.input.type === 'checkbox' ? 'checked' : 'value';
    this.input.addEventListener('input', () => onChange(this.value));
  }

  get value() {
    return this.input[this.valueAttrib];
  }
}

class CubeFace {
  constructor(faceName) {
    this.faceName = faceName;
    this.anchor = document.createElement('a');
    this.anchor.className = 'cube-face-anchor';
    this.anchor.title = faceName;
    
    this.img = document.createElement('img');
    this.img.className = 'cube-face-img';
    this.img.alt = `${faceName} face`;
    
    this.anchor.appendChild(this.img);
  }

  setPreview(url, x, y) {
    this.img.src = url;
    this.anchor.style.transform = `translate(${x}px, ${y}px)`;
    this.img.classList.add('loading');
  }

  setDownload(url, fileExtension) {
    this.anchor.href = url;
    this.anchor.download = `${this.faceName}.${fileExtension}`;
    this.img.classList.remove('loading');
  }
}

function removeChildren(node) {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

const MIME_TYPES = {
  jpg: 'image/jpeg',
  png: 'image/png'
};

async function getDataURL(imgData, extension) {
  try {
    canvas.width = imgData.width;
    canvas.height = imgData.height;
    ctx.putImageData(imgData, 0, 0);
    
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        blob => blob ? resolve(URL.createObjectURL(blob)) : reject(new Error('Canvas to Blob conversion failed')),
        MIME_TYPES[extension],
        0.92
      );
    });
  } catch (error) {
    console.error('Error generating data URL:', error);
    throw error;
  }
}

const dom = {
  imageInput: document.getElementById('imageInput'),
  faces: document.getElementById('faces'),
  generating: document.getElementById('generating')
};

if (!dom.imageInput || !dom.faces || !dom.generating) {
  throw new Error('Required DOM elements not found');
}

const settings = {
  cubeRotation: new Input('cubeRotation', processImage),
  interpolation: new RadioInput('interpolation', processImage),
  format: new RadioInput('format', () => {}) // No need to reprocess for format change
};

const FACE_POSITIONS = {
  pz: { x: 1, y: 1 },
  nz: { x: 3, y: 1 },
  px: { x: 2, y: 1 },
  nx: { x: 0, y: 1 },
  py: { x: 1, y: 0 },
  ny: { x: 1, y: 2 }
};

let activeWorkers = [];
let processedFaces = 0;

function loadImage() {
  const file = dom.imageInput.files[0];
  if (!file) return;

  const img = new Image();
  img.src = URL.createObjectURL(file);

  img.onload = () => {
    try {
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, img.width, img.height);
      processImage(imageData);
    } catch (error) {
      console.error('Error processing image:', error);
      showError('Failed to process the image');
    } finally {
      URL.revokeObjectURL(img.src);
    }
  };

  img.onerror = () => {
    showError('Failed to load the image');
  };
}

function processImage(imageData) {
  cleanupPreviousProcess();
  resetUI();
  
  try {
    Object.entries(FACE_POSITIONS).forEach(([faceName, position]) => {
      renderFace(imageData, faceName, position);
    });
  } catch (error) {
    console.error('Error rendering faces:', error);
    showError('Failed to render cube faces');
  }
}

function cleanupPreviousProcess() {
  removeChildren(dom.faces);
  activeWorkers.forEach(worker => worker.terminate());
  activeWorkers = [];
  processedFaces = 0;
}

function resetUI() {
  dom.generating.style.visibility = 'visible';
}

function renderFace(imageData, faceName, position) {
  const face = new CubeFace(faceName);
  dom.faces.appendChild(face.anchor);

  const worker = new Worker('convert.js');
  activeWorkers.push(worker);

  const options = {
    data: imageData,
    face: faceName,
    rotation: (Math.PI * settings.cubeRotation.value) / 180,
    interpolation: settings.interpolation.value
  };

  worker.onmessage = ({ data: resultData }) => {
    try {
      if (resultData.error) {
        throw new Error(resultData.error);
      }

      if (resultData.isPreview) {
        handlePreviewResult(face, position, resultData, worker, options);
      } else {
        handleFinalResult(face, resultData);
      }
    } catch (error) {
      console.error(`Error processing ${faceName} face:`, error);
      showError(`Failed to process ${faceName} face`);
    }
  };

  worker.onerror = (error) => {
    console.error('Worker error:', error);
    showError('Worker processing failed');
  };

  // First request a preview
  worker.postMessage({
    ...options,
    maxWidth: 200,
    interpolation: 'linear'
  });
}

async function handlePreviewResult(face, position, resultData, worker, options) {
  try {
    const previewUrl = await getDataURL(resultData, 'jpg');
    face.setPreview(
      previewUrl,
      resultData.width * position.x,
      resultData.height * position.y
    );

    // Now request full quality version
    worker.onmessage = ({ data: finalData }) => {
      handleFinalResult(face, finalData);
    };
    worker.postMessage(options);
  } catch (error) {
    console.error('Error generating preview:', error);
    throw error;
  }
}

async function handleFinalResult(face, resultData) {
  try {
    const extension = settings.format.value;
    const finalUrl = await getDataURL(resultData, extension);
    face.setDownload(finalUrl, extension);

    processedFaces++;
    if (processedFaces === 6) {
      dom.generating.style.visibility = 'hidden';
    }
  } catch (error) {
    console.error('Error generating final image:', error);
    throw error;
  }
}

function showError(message) {
  const errorElement = document.createElement('div');
  errorElement.className = 'error-message';
  errorElement.textContent = message;
  dom.faces.appendChild(errorElement);
  dom.generating.style.visibility = 'hidden';
}

// Initialize
dom.imageInput.addEventListener('change', loadImage);

// Add CSS classes for styling (could also be in a separate CSS file)
const style = document.createElement('style');
style.textContent = `
  .cube-face-anchor {
    position: absolute;
    transition: transform 0.3s ease, opacity 0.3s ease;
  }
  .cube-face-img {
    max-width: 100%;
    height: auto;
    border-radius: 4px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    transition: all 0.3s ease;
  }
  .cube-face-img.loading {
    filter: blur(4px);
    opacity: 0.8;
  }
  .error-message {
    color: #ff4444;
    padding: 1em;
    background: #ffeeee;
    border-radius: 4px;
    margin: 1em 0;
  }
`;
document.head.appendChild(style);
