const fs = require("fs");
const path = require("path");

function loadCategories() {

    const categoriesPath = path.join(__dirname, "data/categories");

    const files = fs.readdirSync(categoriesPath);

    const categories = [];

    files.forEach(file => {

        if (!file.endsWith(".json")) return;

        const fullPath = path.join(categoriesPath, file);

        const data = JSON.parse(fs.readFileSync(fullPath, "utf8"));

        categories.push(data);
    });

    return categories;
}

module.exports = loadCategories;